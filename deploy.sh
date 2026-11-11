#!/usr/bin/env bash
# ==============================================================================
# Script: deploy.sh
# Project: bot_report
# Task: BOT-REPORT-DOCKER-DEPLOY-SCRIPT-007
# Checkpoint: CP001-r2
# Description: Automated, repeatable, non-destructive Docker deployment script
#              for the mcp_worker application.
#
# Usage:
#   ./deploy.sh --dry-run
#       Validates environment prerequisites, inspects repository state,
#       authoritatively validates Compose topology, and displays the exact
#       commands that would be executed without making any changes to Git,
#       npm, Docker, or database files. Requires .env.docker.
#
#   ./deploy.sh --apply
#       Executes deployment in sequence:
#       1. Validates environment, tools, bootstrap security, and Compose config.
#       2. Verifies working tree/upstream are safe for a fast-forward deployment.
#       3. Pulls latest code using 'git pull --ff-only' from configured upstream.
#       4. Revalidates bootstrap and Compose configuration after code pull.
#       5. Prepares persistent ./data and the configured external Docker network.
#       6. Rebuilds the application image and force-recreates the service container.
#       7. Waits for Docker health and rejects restart/unhealthy states.
#       8. Reports deployed commit and source provenance.
#
#   ./deploy.sh --help | -h
#       Displays this usage documentation.
#
# Architecture Notes:
#   - Source code is NOT bind-mounted; it is baked directly into the Docker image.
#   - Production node_modules are compiled inside Dockerfile builder stage.
#   - Host data directory ('./data') persists encrypted bootstrap configuration and optional legacy import data.
#   - MySQL is configured from the Admin UI; administrator/bootstrap security remains in .env.docker.
#   - Compose file uses '--env-file .env.docker' for variable substitution.
# ==============================================================================

set -Eeuo pipefail

# ------------------------------------------------------------------------------
# 1. Script Location & Path Discovery
# ------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"

# Configurable overrides for test isolation & flexibility
ENV_FILE="${DEPLOY_ENV_FILE:-${REPO_ROOT}/.env.docker}"
COMPOSE_FILE="${DEPLOY_COMPOSE_FILE:-${REPO_ROOT}/docker-compose.proxy.yml}"
GIT_CMD="${GIT_CMD:-git}"
DOCKER_CMD="${DOCKER_CMD:-docker}"
TARGET_SERVICE="bot-report"
DATA_DIR="${BOT_REPORT_DATA_DIR_HOST:-${REPO_ROOT}/data}"
RUNTIME_UID="${BOT_REPORT_RUNTIME_UID:-1000}"
RUNTIME_GID="${BOT_REPORT_RUNTIME_GID:-1000}"

# Concurrency lock directory (outside repo to prevent dirtying Git working tree)
REPO_HASH="$(echo -n "${REPO_ROOT}" | md5sum | cut -d' ' -f1)"
LOCK_DIR="/tmp/bot_report_deploy_${REPO_HASH}.lock.d"

# ------------------------------------------------------------------------------
# 2. Logging Helpers
# ------------------------------------------------------------------------------
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO]  $*"
}

log_warn() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN]  $*" >&2
}

log_error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $*" >&2
}

read_env_value() {
  local key="$1"
  local line=""
  local value=""
  line="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" | tail -n 1 || true)"
  [[ -n "${line}" ]] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  value="$(printf '%s' "${value}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "${value}" in
    \"*\") value="${value:1:${#value}-2}" ;;
    \'*\') value="${value:1:${#value}-2}" ;;
  esac
  printf '%s' "${value}"
}

validate_bootstrap_environment() {
  log "Validating bootstrap configuration without exposing secrets..."

  local network admin_username admin_password session_secret encryption_key decoded_len
  network="$(read_env_value BOT_REPORT_EXTERNAL_NETWORK || true)"
  admin_username="$(read_env_value ADMIN_USERNAME || true)"
  admin_password="$(read_env_value ADMIN_PASSWORD || true)"
  session_secret="$(read_env_value SESSION_SECRET || true)"
  encryption_key="$(read_env_value APP_ENCRYPTION_KEY || true)"
  if [[ -z "${encryption_key}" ]]; then
    encryption_key="$(read_env_value TERMINAL_CREDENTIAL_KEY || true)"
  fi

  [[ -n "${network}" ]] || { log_error "BOT_REPORT_EXTERNAL_NETWORK must be configured in ${ENV_FILE}."; exit 1; }
  [[ -n "${admin_username}" ]] || { log_error "ADMIN_USERNAME must be configured in ${ENV_FILE}."; exit 1; }
  [[ -n "${admin_password}" ]] || { log_error "ADMIN_PASSWORD must be configured in ${ENV_FILE}."; exit 1; }
  if [[ ${#session_secret} -lt 32 ]]; then
    log_error "SESSION_SECRET must be configured with at least 32 characters."
    exit 1
  fi
  [[ -n "${encryption_key}" ]] || { log_error "APP_ENCRYPTION_KEY (or legacy TERMINAL_CREDENTIAL_KEY) must be configured."; exit 1; }

  if ! decoded_len="$(printf '%s' "${encryption_key}" | base64 -d 2>/dev/null | wc -c | tr -d '[:space:]')" || [[ "${decoded_len}" != "32" ]]; then
    log_error "Application encryption key must be valid base64 for exactly 32 bytes."
    exit 1
  fi

  EXTERNAL_NETWORK="${network}"
  log "Bootstrap configuration validated (admin/session/encryption/network values present; secrets not logged)."

  if find "${ENV_FILE}" -maxdepth 0 -perm /007 -print -quit 2>/dev/null | grep -q .; then
    log_warn "${ENV_FILE} is accessible by 'other' users. Consider chmod 600 for stronger secret protection."
  fi
}

prepare_runtime_prerequisites() {
  log "Preparing persistent runtime prerequisites..."

  if [[ -e "${DATA_DIR}" && ! -d "${DATA_DIR}" ]]; then
    log_error "Persistent data path exists but is not a directory: ${DATA_DIR}"
    exit 1
  fi

  if [[ ! -d "${DATA_DIR}" ]]; then
    if [[ "${MODE}" == "dry-run" ]]; then
      log "[DRY RUN] Would create persistent data directory: ${DATA_DIR}"
      log "[DRY RUN] Would assign runtime ownership ${RUNTIME_UID}:${RUNTIME_GID} to the new directory."
    else
      mkdir -p "${DATA_DIR}"
      if [[ "$(id -u)" == "0" ]]; then
        chown "${RUNTIME_UID}:${RUNTIME_GID}" "${DATA_DIR}"
      elif [[ "$(id -u)" != "${RUNTIME_UID}" ]]; then
        log_error "Fresh data directory requires ownership ${RUNTIME_UID}:${RUNTIME_GID}, but deploy user UID is $(id -u)."
        log_error "Run deployment as root or pre-create/chown ${DATA_DIR} for the container runtime user."
        exit 1
      fi
      chmod 750 "${DATA_DIR}"
      log "Created persistent data directory: ${DATA_DIR}"
    fi
  else
    log "Persistent data directory already exists; preserving its contents: ${DATA_DIR}"
    if [[ "${MODE}" == "apply" && "$(id -u)" == "0" ]]; then
      chown "${RUNTIME_UID}:${RUNTIME_GID}" "${DATA_DIR}"
    fi
  fi

  if "${DOCKER_CMD}" network inspect "${EXTERNAL_NETWORK}" >/dev/null 2>&1; then
    log "External Docker network is available: ${EXTERNAL_NETWORK}"
  elif [[ "${MODE}" == "dry-run" ]]; then
    log "[DRY RUN] Would create missing external Docker network: ${EXTERNAL_NETWORK}"
  else
    log "Creating missing external Docker network: ${EXTERNAL_NETWORK}"
    "${DOCKER_CMD}" network create "${EXTERNAL_NETWORK}" >/dev/null
    log "External Docker network created: ${EXTERNAL_NETWORK}"
  fi
}

# ------------------------------------------------------------------------------
# 3. Usage & Help Documentation
# ------------------------------------------------------------------------------
usage() {
  cat << 'EOF'
Usage: ./deploy.sh [OPTIONS]

Automated, safe Docker deployment script for mcp_worker.

Options:
  --dry-run   Validate bootstrap ENV, deployment topology, persistent data/network,
              Git upstream, and show the exact build/recreate plan without mutation.
  --apply     Validate, prepare fresh-VPS prerequisites, pull latest code (--ff-only),
              rebuild the image, force-recreate the container, and verify health.
  -h, --help  Display this help message and exit.

Environment Configuration:
  Target Compose file: docker-compose.proxy.yml
  Target Service:      bot-report
  Target Env File:     .env.docker

Safety Guards:
  - Validates ADMIN_USERNAME/ADMIN_PASSWORD, SESSION_SECRET, and application encryption key without logging secrets.
  - Rejects dirty tracked, staged, and untracked Git changes (protects build context).
  - Authoritatively validates Docker Compose with --env-file .env.docker.
  - Creates only the configured external Docker network when it is missing.
  - Creates only the persistent ./data directory when it is missing; existing contents are preserved.
  - Uses 'git pull --ff-only' (rejects non-fast-forward diverged branches).
  - Revalidates deployment configuration after pulling upstream updates.
  - Concurrency lock prevents simultaneous deployment collisions.
  - Never deletes volumes, MySQL databases, or legacy SQLite data.
EOF
}

# ------------------------------------------------------------------------------
# 4. Concurrency Lock Management
# ------------------------------------------------------------------------------
LOCKED_BY_ME=false

acquire_lock() {
  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    local lock_pid=""
    if [[ -f "${LOCK_DIR}/pid" ]]; then
      lock_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
    fi

    if [[ -n "${lock_pid}" ]] && kill -0 "${lock_pid}" 2>/dev/null; then
      log_error "Conflicting deployment in progress (PID: ${lock_pid})."
      log_error "Cannot execute concurrent deployments for repository: ${REPO_ROOT}"
      exit 1
    else
      log_warn "Found stale deployment lock (PID: ${lock_pid:-unknown} is inactive). Clearing stale lock."
      rm -rf "${LOCK_DIR}"
      if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
        log_error "Failed to acquire deployment lock after stale cleanup."
        exit 1
      fi
    fi
  fi

  echo "$$" > "${LOCK_DIR}/pid"
  LOCKED_BY_ME=true
  log "Deployment lock acquired (PID: $$)."
}

release_lock() {
  if [[ "${LOCKED_BY_ME:-false}" == "true" && -d "${LOCK_DIR:-}" ]]; then
    rm -rf "${LOCK_DIR}" 2>/dev/null || true
  fi
}

trap 'release_lock' EXIT INT TERM

# ------------------------------------------------------------------------------
# 5. Step A: Environment & Prerequisite Validation
# ------------------------------------------------------------------------------
validate_prerequisites() {
  log "Validating deployment prerequisites..."

  # 1. Require Git
  if ! command -v "${GIT_CMD}" >/dev/null 2>&1; then
    log_error "Required command '${GIT_CMD}' is not installed or not in PATH."
    exit 1
  fi

  # 2. Require Docker
  if ! command -v "${DOCKER_CMD}" >/dev/null 2>&1; then
    log_error "Required command '${DOCKER_CMD}' is not installed or not in PATH."
    exit 1
  fi

  # 3. Require Docker Compose (v2 plugin)
  if ! "${DOCKER_CMD}" compose version >/dev/null 2>&1; then
    log_error "Docker Compose (v2 plugin) is required but not functional via '${DOCKER_CMD} compose'."
    exit 1
  fi

  # 4. Require base64 for application encryption key validation.
  if ! command -v base64 >/dev/null 2>&1; then
    log_error "Required command 'base64' is not installed or not in PATH."
    exit 1
  fi

  # 5. Validate Compose file existence
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    log_error "Docker Compose file not found: ${COMPOSE_FILE}"
    exit 1
  fi
  log "Docker Compose file: ${COMPOSE_FILE}"

  # 6. Validate .env.docker existence (DEP007-03: real env file required in both dry-run and apply)
  if [[ ! -f "${ENV_FILE}" ]]; then
    log_error "Required environment file not found: ${ENV_FILE}"
    log_error "Deployment requires the real '.env.docker' file. Refusing to substitute example files."
    exit 1
  fi
  log "Runtime Environment file: ${ENV_FILE}"

  # 7. Validate bootstrap security/runtime settings without logging secret values.
  validate_bootstrap_environment

  # 8. Authoritative Docker Compose validation.
  validate_compose_configuration
}

validate_compose_configuration() {
  log "Authoritatively validating Docker Compose configuration..."

  local services=""
  if ! services="$("${DOCKER_CMD}" compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --services 2>&1)"; then
    log_error "Docker Compose configuration validation failed via '${DOCKER_CMD} compose config'!"
    log_error "${services}"
    exit 1
  fi

  # Ensure the intended target service 'bot-report' is explicitly defined
  if ! echo "${services}" | grep -Fxq "${TARGET_SERVICE}"; then
    log_error "Target deployment service '${TARGET_SERVICE}' is not defined in Compose configuration!"
    log_error "Available services:\n${services}"
    exit 1
  fi

  SERVICE_NAME="${TARGET_SERVICE}"
  log "Authoritatively validated target Docker Compose service: ${SERVICE_NAME}"
}

# ------------------------------------------------------------------------------
# 6. Architecture & Mount Topology Inspection
# ------------------------------------------------------------------------------
analyze_architecture() {
  log "Analyzing Docker container architecture and volume topology..."

  # 1. Source bind mount analysis
  local has_src_mount="NO"
  if grep -E "source:[ ]*(\./src|\./|\.)[ ]*$" "${COMPOSE_FILE}" >/dev/null 2>&1; then
    has_src_mount="YES"
  elif grep -E -- "-[ ]*['\"]?(\./src|\.):/app" "${COMPOSE_FILE}" >/dev/null 2>&1; then
    has_src_mount="YES"
  fi

  # 2. node_modules location analysis
  local modules_location="Docker image"
  if grep -E "node_modules" "${COMPOSE_FILE}" >/dev/null 2>&1; then
    modules_location="Docker volume / mount"
  fi

  # 3. Data persistence bind mount
  local has_data_mount="NO"
  if grep -E "source:[ ]*\./data" "${COMPOSE_FILE}" >/dev/null 2>&1; then
    has_data_mount="YES (./data -> /app/data)"
  fi

  log "Architecture Summary:"
  log "  - Compose Service Name:    ${SERVICE_NAME}"
  log "  - Source Code Bind Mount:  ${has_src_mount} (baked into container image)"
  log "  - node_modules Location:   ${modules_location} (compiled in multi-stage Dockerfile)"
  log "  - Persistent Data Mount:   ${has_data_mount}"
  log "  - Dependency Strategy:     Docker image build (--build) compiles native addons via Dockerfile builder"
}

# ------------------------------------------------------------------------------
# 7. Git Working Tree & Upstream Validation (DEP007-01, DEP007-R1-01, DEP007-R1-02)
# ------------------------------------------------------------------------------
validate_git_state() {
  log "Validating Git repository status and upstream configuration..."

  if ! "${GIT_CMD}" -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log_error "Directory '${REPO_ROOT}' is not a valid Git repository."
    exit 1
  fi

  local current_branch current_head
  if ! current_branch="$("${GIT_CMD}" -C "${REPO_ROOT}" branch --show-current 2>&1)"; then
    log_error "Git integrity check failed: '${GIT_CMD} branch --show-current' exited with nonzero status."
    log_error "Output: ${current_branch}"
    exit 1
  fi

  if ! current_head="$("${GIT_CMD}" -C "${REPO_ROOT}" rev-parse --short HEAD 2>&1)"; then
    log_error "Git integrity check failed: '${GIT_CMD} rev-parse --short HEAD' exited with nonzero status."
    log_error "Output: ${current_head}"
    exit 1
  fi
  log "Current Git branch: ${current_branch:-DETACHED} (${current_head})"

  # Upstream tracking branch verification
  local upstream=""
  if ! upstream="$("${GIT_CMD}" -C "${REPO_ROOT}" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"; then
    upstream=""
  fi

  if [[ -z "${upstream}" ]]; then
    log_error "No tracking upstream branch configured for branch '${current_branch}'."
    log_error "Cannot safely pull updates without a configured upstream (e.g. origin/${current_branch})."
    exit 1
  fi
  log "Configured upstream: ${upstream}"

  # DEP007-R1-02: Fail-closed Git status error propagation (no error swallowing via || true)
  local dirty_unstaged dirty_staged untracked_files ignored_build_files

  # 1. Unstaged tracked modifications
  if ! dirty_unstaged="$("${GIT_CMD}" -C "${REPO_ROOT}" diff --name-only 2>&1)"; then
    log_error "Git integrity check failed: '${GIT_CMD} diff --name-only' returned nonzero exit code."
    log_error "Output: ${dirty_unstaged}"
    exit 1
  fi

  # 2. Staged modifications in index
  if ! dirty_staged="$("${GIT_CMD}" -C "${REPO_ROOT}" diff --cached --name-only 2>&1)"; then
    log_error "Git integrity check failed: '${GIT_CMD} diff --cached --name-only' returned nonzero exit code."
    log_error "Output: ${dirty_staged}"
    exit 1
  fi

  # 3. Standard untracked files
  if ! untracked_files="$("${GIT_CMD}" -C "${REPO_ROOT}" ls-files --others --exclude-standard 2>&1)"; then
    log_error "Git integrity check failed: '${GIT_CMD} ls-files --others --exclude-standard' returned nonzero exit code."
    log_error "Output: ${untracked_files}"
    exit 1
  fi

  # 4. DEP007-R1-01: Git-ignored source files that would enter Docker build context
  # Inspect Dockerfile-copied paths (src/, docker-entrypoint.sh, package.json, package-lock.json)
  # that are Git-ignored (.git/info/exclude or .gitignore) but NOT excluded by .dockerignore.
  if ! ignored_build_files="$("${GIT_CMD}" -C "${REPO_ROOT}" ls-files --others --ignored --exclude-standard -- src/ docker-entrypoint.sh package.json package-lock.json 2>&1)"; then
    log_error "Git integrity check failed: '${GIT_CMD} ls-files --others --ignored --exclude-standard' returned nonzero exit code."
    log_error "Output: ${ignored_build_files}"
    exit 1
  fi

  if [[ -n "${dirty_unstaged}" || -n "${dirty_staged}" || -n "${untracked_files}" || -n "${ignored_build_files}" ]]; then
    log_error "Working tree integrity check failed! Uncommitted, untracked, or Git-ignored source changes detected:"
    if [[ -n "${dirty_staged}" ]]; then
      log_error "Staged tracked files:\n${dirty_staged}"
    fi
    if [[ -n "${dirty_unstaged}" ]]; then
      log_error "Unstaged modified files:\n${dirty_unstaged}"
    fi
    if [[ -n "${untracked_files}" ]]; then
      log_error "Untracked build-context / application files:\n${untracked_files}"
    fi
    if [[ -n "${ignored_build_files}" ]]; then
      log_error "Git-ignored source files entering Docker build context (unexcluded by .dockerignore):\n${ignored_build_files}"
    fi
    log_error "Deployment requires a clean Git working tree to prevent unreviewed changes from entering the Docker build context."
    log_error "Please commit, review, or clean these changes before deploying."
    exit 1
  fi

  log "Working tree is clean. Zero uncommitted tracked, staged, untracked, or build-eligible ignored files."
}

# ------------------------------------------------------------------------------
# 8. Step B: Pull Source Code
# ------------------------------------------------------------------------------
pull_source_code() {
  if [[ "${MODE}" == "dry-run" ]]; then
    log "[DRY RUN] Would execute: ${GIT_CMD} pull --ff-only"
    return 0
  fi

  log "Pulling latest changes from upstream (fast-forward only)..."
  if ! "${GIT_CMD}" -C "${REPO_ROOT}" pull --ff-only; then
    log_error "'${GIT_CMD} pull --ff-only' failed!"
    log_error "Upstream branch has diverged or cannot be fast-forwarded."
    log_error "Aborting deployment. Working tree remains unmerged."
    exit 1
  fi
  log "Source code successfully updated to commit $("${GIT_CMD}" -C "${REPO_ROOT}" rev-parse --short HEAD)."
}

# ------------------------------------------------------------------------------
# 9. Step C: Dependency Synchronization Strategy
# ------------------------------------------------------------------------------
sync_dependencies() {
  log "Evaluating dependency synchronization..."
  # Because source and node_modules are baked into the container image,
  # dependencies are installed during the multi-stage Docker build ('npm ci --omit=dev').
  # Running redundant npm install on the host is unnecessary and risks glibc/musl mismatch.
  log "Container image rebuild will execute 'npm ci --omit=dev' inside the Dockerfile builder stage."
  log "Host node_modules remains isolated from the Alpine container runtime."
}

# ------------------------------------------------------------------------------
# 10. Step D: Restart / Recreate Service Container
# ------------------------------------------------------------------------------
restart_service_container() {
  local git_sha
  local build_time
  git_sha="$("${GIT_CMD}" -C "${REPO_ROOT}" rev-parse HEAD)"
  build_time="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

  local compose_cmd=(
    "${DOCKER_CMD}" compose
    --env-file "${ENV_FILE}"
    -f "${COMPOSE_FILE}"
    up -d
    --build
    --force-recreate
    --no-deps
    "${SERVICE_NAME}"
  )

  if [[ "${MODE}" == "dry-run" ]]; then
    log "[DRY RUN] Build provenance: BOT_REPORT_GIT_SHA=${git_sha} BOT_REPORT_BUILD_TIME=${build_time}"
    log "[DRY RUN] Would execute: ${compose_cmd[*]}"
    return 0
  fi

  log "Rebuilding and recreating container '${SERVICE_NAME}' with source provenance ${git_sha:0:12}..."
  if ! BOT_REPORT_GIT_SHA="${git_sha}" BOT_REPORT_BUILD_TIME="${build_time}" "${compose_cmd[@]}"; then
    log_error "Failed to recreate container '${SERVICE_NAME}' with Docker Compose!"
    exit 1
  fi
  log "Container recreate command exited successfully."
}

# ------------------------------------------------------------------------------
# 11. Step E: Verify Deployment Health & Readiness
# ------------------------------------------------------------------------------
verify_deployment() {
  if [[ "${MODE}" == "dry-run" ]]; then
    log "[DRY RUN] Would verify container state (running, restart loop check, healthcheck status, logs)."
    return 0
  fi

  log "Verifying container runtime state and readiness..."

  local container_id
  container_id="$("${DOCKER_CMD}" compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" ps -q "${SERVICE_NAME}" 2>/dev/null || true)"

  if [[ -z "${container_id}" ]]; then
    log_error "Target container for service '${SERVICE_NAME}' was not found after deployment!"
    exit 1
  fi
  log "Container ID: ${container_id}"

  # Check running & restart status
  local is_running is_restarting restart_count
  is_running="$("${DOCKER_CMD}" inspect --format '{{.State.Running}}' "${container_id}" 2>/dev/null || echo "false")"
  is_restarting="$("${DOCKER_CMD}" inspect --format '{{.State.Restarting}}' "${container_id}" 2>/dev/null || echo "false")"
  restart_count="$("${DOCKER_CMD}" inspect --format '{{.RestartCount}}' "${container_id}" 2>/dev/null || echo "0")"

  if [[ "${is_running}" != "true" || "${is_restarting}" == "true" ]]; then
    log_error "Container '${SERVICE_NAME}' is not healthy! (Running: ${is_running}, Restarting: ${is_restarting}, Restarts: ${restart_count})"
    log_error "Recent container logs:"
    "${DOCKER_CMD}" logs --tail 30 "${container_id}" >&2 || true
    exit 1
  fi

  # Healthcheck polling if configured (DEP007-04: Readiness hardening)
  local has_health
  has_health="$("${DOCKER_CMD}" inspect --format '{{if .State.Health}}yes{{else}}no{{end}}' "${container_id}" 2>/dev/null || echo "no")"

  if [[ "${has_health}" == "yes" ]]; then
    log "Container has healthcheck configured. Waiting for health readiness (up to 45s)..."
    local health_status="starting"
    local elapsed=0
    local timeout=45

    while [[ ${elapsed} -lt ${timeout} ]]; do
      health_status="$("${DOCKER_CMD}" inspect --format '{{.State.Health.Status}}' "${container_id}" 2>/dev/null || echo "unknown")"
      log "Health status after ${elapsed}s: ${health_status}"

      if [[ "${health_status}" == "healthy" ]]; then
        break
      elif [[ "${health_status}" == "unhealthy" ]]; then
        log_error "Container health check failed! Status: unhealthy"
        log_error "Recent container logs:"
        "${DOCKER_CMD}" logs --tail 30 "${container_id}" >&2 || true
        exit 1
      fi

      sleep 3
      elapsed=$((elapsed + 3))
    done

    if [[ "${health_status}" != "healthy" ]]; then
      log_error "Timeout reached waiting for container to report healthy (last status: ${health_status})."
      "${DOCKER_CMD}" logs --tail 30 "${container_id}" >&2 || true
      exit 1
    fi
  else
    log_warn "No Docker healthcheck defined on container '${SERVICE_NAME}'!"
    log_warn "Readiness status: READINESS_UNVERIFIED (container running, but application-level readiness not verified)."
  fi

  local readiness_verdict="DEPLOYMENT SUCCESSFUL"
  if [[ "${has_health}" != "yes" ]]; then
    readiness_verdict="DEPLOYMENT SUCCESSFUL (READINESS_UNVERIFIED)"
  fi

  # Log snippet & commit confirmation
  log "Recent container log output:"
  "${DOCKER_CMD}" logs --tail 10 "${container_id}" 2>&1 | sed 's/^/  [LOG] /' || true

  local deployed_commit
  deployed_commit="$("${GIT_CMD}" -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  log "========================================================================"
  log "${readiness_verdict}"
  log "Service:         ${SERVICE_NAME}"
  log "Deployed Commit: ${deployed_commit}"
  log "Container ID:    ${container_id}"
  log "========================================================================"
}

# ------------------------------------------------------------------------------
# 12. Main Execution Flow
# ------------------------------------------------------------------------------
main() {
  if [[ $# -eq 0 ]]; then
    usage
    exit 1
  fi

  local mode=""
  case "$1" in
    --dry-run)
      mode="dry-run"
      ;;
    --apply)
      mode="apply"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac

  MODE="${mode}"
  log "Starting mcp_worker deployment script in '${MODE}' mode..."

  # Concurrency protection
  acquire_lock

  # Step A: Validate environment & prerequisites (authoritative Compose validation & real .env.docker)
  validate_prerequisites

  # Step A: Inspect architecture & mount topology
  analyze_architecture

  # Step A: Validate Git upstream & clean tree (fail-closed against untracked/staged/modified)
  validate_git_state

  # Step B: Pull latest code
  pull_source_code

  # Step B.2: Revalidate deployment configuration after pull.
  if [[ "${MODE}" == "apply" ]]; then
    log "Revalidating bootstrap and Docker Compose configuration after code pull..."
    validate_bootstrap_environment
    validate_compose_configuration
  fi

  # Step B.3: Prepare fresh-VPS persistent storage and external network.
  prepare_runtime_prerequisites

  # Step C: Dependency synchronization strategy
  sync_dependencies

  # Step D: Rebuild & recreate container
  restart_service_container

  # Step E: Verify deployment readiness
  verify_deployment

  if [[ "${MODE}" == "dry-run" ]]; then
    log "========================================================================"
    log "DRY RUN COMPLETE — All prerequisites, topology, and guards validated."
    log "Run with '--apply' to execute production deployment on the VPS."
    log "========================================================================"
  fi
}

main "$@"
