#!/bin/sh
# Standalone local installation. No host package changes or destructive DB actions.
set -eu
umask 077
cd "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() { echo "Usage: ./setup.sh [--init|--down] (default: start without schema initialization)"; }
mode=start
case "${1:-}" in
  '') ;;
  --init) mode=init ;;
  --down) mode=down ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac
[ "$#" -le 1 ] || fail "Unexpected arguments."
for cmd in docker openssl flock git; do command -v "$cmd" >/dev/null 2>&1 || fail "Missing prerequisite: $cmd"; done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 required."
docker info >/dev/null 2>&1 || fail "Docker daemon unavailable."
envfile="${MCP_WORKER_SETUP_ENV:-.env.setup}"
case "$envfile" in .env.setup|.env.setup-*) ;; *) fail "Use a local .env.setup or .env.setup-* file." ;; esac
case "$envfile" in */*) fail "Invalid env file path." ;; esac
[ ! -L "$envfile" ] && [ ! -L "$envfile.lock" ] || fail "Symlink state refused."
exec 9>"$envfile.lock"
flock -n 9 || fail "Another setup is running."
# Compose shell variables take precedence over env-file; refuse implicit secret overrides.
unset ADMIN_PASSWORD SESSION_SECRET APP_ENCRYPTION_KEY COMPOSE_PROJECT_NAME
project="${MCP_WORKER_SETUP_PROJECT:-mcp_worker}"
port="${MCP_WORKER_SETUP_PORT:-3333}"
case "$project" in ''|*[!a-z0-9_-]*|[-_]*) fail "Invalid Compose project name." ;; esac
case "$port" in ''|*[!0-9]*) fail "Invalid port." ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "Invalid port."
unset MCP_WORKER_PORT
if [ ! -e "$envfile" ]; then
  [ "$mode" != down ] || fail "No installation configuration."
  # Prevent a renamed default installation from silently bypassing old data.
  if [ "$project" = mcp_worker ]; then
    for suffix in app-data mysql-data; do
      if docker volume inspect "bot-report_$suffix" >/dev/null 2>&1; then
        fail "Legacy deployment volumes found; restore original installer env or choose an explicit new project."
      fi
    done
  fi
  # Lost credentials must never be regenerated over existing volumes.
  for suffix in app-data mysql-data; do
    if docker volume inspect "${project}_$suffix" >/dev/null 2>&1; then fail "Existing volume found; restore original installer env."; fi
  done
  tmp=$(mktemp "./$envfile.XXXXXX")
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  {
    printf 'COMPOSE_PROJECT_NAME=%s\nMCP_WORKER_PORT=%s\n' "$project" "$port"
    printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'APP_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)"
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$envfile"
  trap - EXIT HUP INT TERM
fi
[ -f "$envfile" ] || fail "Installer env is not a regular file."
# Never relaunch an old two-volume deployment as an empty SQLite instance.
if grep -Eq '^MYSQL_(PASSWORD|ROOT_PASSWORD)=' "$envfile"; then
  fail "Legacy MySQL installer config detected. Preserve this file; migrate and verify a copy before switching."
fi
chmod 600 "$envfile"
# Read only non-secret values; never source the file as shell code.
project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$envfile")
port=$(sed -n 's/^MCP_WORKER_PORT=//p' "$envfile")
case "$project" in ''|*[!a-z0-9_-]*|[-_]*) fail "Invalid saved project." ;; esac
case "$port" in ''|*[!0-9]*) fail "Invalid saved port." ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "Invalid saved port."
if docker volume inspect "${project}_mysql-data" >/dev/null 2>&1; then
  fail "Legacy MySQL volume detected. Preserve it and follow the offline migration runbook; no automatic cutover."
fi
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  export MCP_WORKER_GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  export MCP_WORKER_TREE_SHA="$(git rev-parse 'HEAD^{tree}' 2>/dev/null || echo unknown)"
  export MCP_WORKER_BUILD_TIME="$(git show -s --format=%cI HEAD 2>/dev/null || echo unknown)"
else
  # Uncommitted development edits may be built but never claim an immutable commit.
  export MCP_WORKER_GIT_SHA=uncommitted
  export MCP_WORKER_TREE_SHA=uncommitted
  export MCP_WORKER_BUILD_TIME=uncommitted
fi
compose() { docker compose --env-file "$envfile" -p "$project" -f docker-compose.yml "$@"; }
compose config -q || fail "Invalid installer configuration."
if [ "$mode" = down ]; then
  compose down
  echo "Stopped. Data volumes and $envfile retained."
  exit 0
fi
# Renamed Compose service must never race the old service against one SQLite volume.
legacy_running="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=mcp_worker')"
[ -z "$legacy_running" ] || fail 'Old mcp_worker container is running. Stop it before starting the renamed server; keep its volume.'
# Preserve running containers on errors; no automatic down -v or reset.
# A matching local image is the default fast path; never trust an image tag alone.
image="${project}-app:local"
revision="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
source_tree="$(docker image inspect "$image" --format '{{index .Config.Labels "org.mcp_worker.source-tree"}}' 2>/dev/null || true)"
# A fresh clone may already have the published image cached under its Docker Hub tag.
# Reuse it only when the exact checked-out commit and tree match; never pull implicitly.
if [ "$MCP_WORKER_GIT_SHA" != uncommitted ] && [ "${MCP_WORKER_FORCE_BUILD:-0}" != 1 ] &&
   { [ "$revision" != "$MCP_WORKER_GIT_SHA" ] || [ "$source_tree" != "$MCP_WORKER_TREE_SHA" ]; }; then
  cached="${MCP_WORKER_SOURCE_IMAGE:-mathew15604/mcp-worker:dev-main}"
  candidate_revision="$(docker image inspect "$cached" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  candidate_tree="$(docker image inspect "$cached" --format '{{index .Config.Labels "org.mcp_worker.source-tree"}}' 2>/dev/null || true)"
  if [ "$candidate_revision" = "$MCP_WORKER_GIT_SHA" ] && [ "$candidate_tree" = "$MCP_WORKER_TREE_SHA" ]; then
    docker tag "$cached" "$image" || fail 'Unable to reuse cached image.'
    revision="$candidate_revision"
    source_tree="$candidate_tree"
    echo "Reusing cached Docker image $cached for this exact source."
  fi
fi
if [ "$MCP_WORKER_GIT_SHA" != uncommitted ] && [ "${MCP_WORKER_FORCE_BUILD:-0}" != 1 ] && [ "$revision" = "$MCP_WORKER_GIT_SHA" ] && [ "$source_tree" = "$MCP_WORKER_TREE_SHA" ]; then
  echo "Using matching local image: $image (no source rebuild)."
  compose up -d --no-build --wait --wait-timeout 240 || fail "Startup failed; data retained."
else
  echo "Building source image (local image missing, stale or forced)."
  compose up -d --build --wait --wait-timeout 240 || fail "Startup failed; data retained."
fi
if [ "$mode" = init ]; then
  compose exec -T server node scripts/init-bundled-db.js --init-fresh || fail "Initialization refused or failed; data retained. Use Admin database recovery."
  # Reload encrypted bootstrap only if the current app is not already ready.
  if ! compose exec -T server node -e "fetch('http://127.0.0.1/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    compose restart server
  fi
  i=0
  until compose exec -T server node -e "fetch('http://127.0.0.1/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -lt 60 ] || fail "Readiness timeout; data retained."
    sleep 2
  done
fi
printf 'Admin: http://127.0.0.1:%s/admin (username admin; password in %s)\n' "$port" "$envfile"
