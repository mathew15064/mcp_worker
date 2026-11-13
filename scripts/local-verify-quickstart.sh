#!/usr/bin/env bash
# T1: Manual, PC-only verification. No GitHub Actions, deploy, publish or release.
set -uo pipefail
umask 077

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PINNED_SHA="ae588a1a56f2561ca2323457463e5b9e203de509"
CURRENT_BRANCH="$(git -C "$ROOT" branch --show-current)"

die() { printf 'LOCAL_VERIFY_REFUSED: %s\n' "$1" >&2; exit 2; }
command -v git >/dev/null 2>&1 || die "git is required"
# Branch AND canonical worktree path are a fixed allowlist, not a user-supplied
# wildcard or environment override. The original/shared base, staging, and
# production checkouts are never accepted as verification targets.
case "$CURRENT_BRANCH:$ROOT" in
  work/railway-final-t1:/root/mcp_worker_railway_final_t1_20261113|\
  work/oneclick-unblock-t1:/root/mcp_worker_oneclick_unblock_t1_20261113|\
  work/railway-oneclick-final-integration-20261113:/root/mcp_worker_railway_oneclick_final_integration_20261113) ;;
  *) die "not an explicitly authorized PC branch AND worktree (T1 or final integration)" ;;
esac
git -C "$ROOT" cat-file -e "${PINNED_SHA}^{commit}" 2>/dev/null ||
  die "pinned commit is missing"
git -C "$ROOT" merge-base --is-ancestor "$PINNED_SHA" HEAD ||
  die "current HEAD does not descend from the pinned commit"
[[ "$(git -C "$ROOT" rev-parse --show-toplevel)" == "$ROOT" ]] ||
  die "cannot verify worktree root"
# Refuse changes including staged files and untracked source, before npm ci.
# Runtime artifacts are deliberately written outside the repository.
[[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=normal)" ]] ||
  die "worktree must be clean (tracked, staged, and untracked files)"

HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
SHORT_SHA="${HEAD_SHA:0:12}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_PARENT="${LOCAL_VERIFY_REPORT_DIR:-$ROOT/../mcp_worker_t01_evidence}"
mkdir -p -- "$REPORT_PARENT" || die "cannot create evidence directory"
REPORT_PARENT="$(CDPATH= cd -- "$REPORT_PARENT" && pwd -P)"
case "$REPORT_PARENT/" in
  "$ROOT/"*) die "evidence directory must be outside the source worktree" ;;
esac
REPORT="$REPORT_PARENT/$STAMP-$SHORT_SHA-$$"
mkdir -m 700 -- "$REPORT" || die "cannot create exclusive evidence directory"
mkdir -m 700 -- "$REPORT/logs"
SCRATCH="$(mktemp -d "$REPORT/.private-run.XXXXXXXX")" || die "cannot create private scratch"
trap 'rm -rf -- "$SCRATCH"' EXIT
RESULTS="$REPORT/results.tsv"
printf 'gate\tstatus\texit_code\tstarted_utc\tended_utc\tduration_seconds\ttest_skips\tnote\n' > "$RESULTS"

safe_version() {
  local name="$1"; shift
  if command -v "$name" >/dev/null 2>&1; then
    "$@" 2>&1 | head -1 | cut -c 1-160
  else
    printf 'MISSING\n'
  fi
}
NODE_VERSION="$(safe_version node node --version)"
NPM_VERSION="$(safe_version npm npm --version)"
GO_VERSION="$(safe_version go go version)"
# Resolve the module-pinned Go toolchain from the PC's existing local cache.
# GOPROXY=off forbids any toolchain download during resolution or test.
LOCAL_GO_DIR=''
if command -v go >/dev/null 2>&1; then
  module_goroot="$(cd "$ROOT/worker-go" && GOTOOLCHAIN=auto GOPROXY=off go env GOROOT 2>/dev/null || true)"
  if [[ -x "$module_goroot/bin/go" ]]; then
    LOCAL_GO_DIR="$module_goroot/bin"
    GO_VERSION="$("$LOCAL_GO_DIR/go" version)"
  fi
fi
# npm lifecycle scripts must use the same Node 22 executable as the harness.
# Some minimal subprocess environments otherwise fall back to /usr/bin/node 18.
NODE_BIN_REAL="$(readlink -f "$(command -v node)")"
[[ -x "$NODE_BIN_REAL" ]] || die 'a verified Node executable is required'
TEST_PATH="$(dirname "$NODE_BIN_REAL"):${LOCAL_GO_DIR:+$LOCAL_GO_DIR:}$PATH"
DOCKER_VERSION="$(safe_version docker docker --version)"
OPENSSL_VERSION="$(safe_version openssl openssl version)"
{
  printf 'task=T1\n'
  printf 'source_sha=%s\n' "$HEAD_SHA"
  printf 'pinned_base_sha=%s\n' "$PINNED_SHA"
  printf 'branch=%s\n' "$CURRENT_BRANCH"
  printf 'started_utc=%s\n' "$(date -u +%FT%TZ)"
  printf 'os=%s\n' "$(uname -s -m)"
  printf 'node=%s\nnpm=%s\ngo=%s\ndocker=%s\nopenssl=%s\n' \
    "$NODE_VERSION" "$NPM_VERSION" "$GO_VERSION" "$DOCKER_VERSION" "$OPENSSL_VERSION"
  printf 'execution=PC-local; no remote deployment, publication or CI\n'
  printf 'npm_offline=%s\n' "${LOCAL_VERIFY_NPM_OFFLINE:-0}"
  printf 'git_status_dirty=%s\n' "$(test -z "$(git -C "$ROOT" status --porcelain)" && echo no || echo yes)"
} > "$REPORT/metadata.txt"
printf 'Evidence: %s\n' "$REPORT"

# A temporary raw log is created in a private 0700 directory and destroyed.
# Persist ONLY sanitized, bounded diagnostic logs. No env dumps or test fixtures.
sanitize() {
  awk '
    {
      gsub(/\033\[[0-9;]*[[:alpha:]]/, "")
      l=tolower($0)
      if (l ~ /(secret|password|passwd|api[_-]?key|auth(orization)?[_-]?(token|header)|bearer|cookie|credential|private key|private-key|-----begin |-----end |token[=:]|key[=:]|session[=:]|\.pem|\.key|@[^ ]+\.[a-z]{2,})/) {
        print "[REDACTED sensitive-looking line]"; next
      }
      if (length($0)>600) print substr($0,1,600) " [TRUNCATED]"
      else print
    }
  ' "$1" | tail -n 500 > "$2"
}
record() {
  local gate="$1" status="$2" code="$3" seconds="$4" skips="$5" note="$6"
  local started="${7:-$(date -u +%FT%TZ)}" ended="${8:-$(date -u +%FT%TZ)}"
  note="${note//$'\t'/ }"; note="${note//$'\n'/ }"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$gate" "$status" "$code" "$started" "$ended" "$seconds" "$skips" "$note" >> "$RESULTS"
  printf '%-30s %-10s %ss %s\n' "$gate" "$status" "$seconds" "$note"
}
omit() {
  local gate="$1" status="$2" why="$3"
  printf '%s: %s\n' "$status" "$why" > "$REPORT/logs/$gate.log"
  record "$gate" "$status" "-" "0" "-" "$why"
}
# Pass commands as discrete argv; never eval/execute user-provided strings.
run() {
  local gate="$1" budget="$2" note="$3"
  shift 3
  local raw start elapsed code status skips started_utc ended_utc
  raw="$(mktemp "$SCRATCH/$gate.XXXXXXXX")" || die "scratch unavailable"
  started_utc="$(date -u +%FT%TZ)"
  start="$(date +%s)"
  (
    cd -- "$ROOT" || exit 1
    # Allow only minimal, non-secret host context to enter test processes.
    env -i PATH="$TEST_PATH" NODE="$NODE_BIN_REAL" HOME="$HOME" USER="${USER:-local}" \
      LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=false GOTOOLCHAIN=local GOPROXY=off \
      npm_config_audit=false npm_config_fund=false \
      npm_config_update_notifier=false NO_PROXY=127.0.0.1,localhost,::1 \
      no_proxy=127.0.0.1,localhost,::1 \
      npm_config_offline="${LOCAL_VERIFY_NPM_OFFLINE:-false}" \
      timeout --signal=TERM --kill-after=10s "$budget" "$@"
  ) > "$raw" 2>&1
  code=$?
  ended_utc="$(date -u +%FT%TZ)"
  elapsed=$(( $(date +%s) - start ))
  skips="$(grep -E '^[[:space:]]*# skipped [0-9]+' "$raw" | tail -n 1 | awk '{print $3}' || true)"
  skips="${skips:-0}"
  if [[ "$code" -eq 0 ]]; then status=PASS; else status=FAIL; fi
  if [[ "$code" -eq 124 || "$code" -eq 137 ]]; then note="$note; timed out"; fi
  if [[ "$skips" != 0 ]]; then note="$note; internal TAP skips=$skips"; fi
  sanitize "$raw" "$REPORT/logs/$gate.log"
  rm -f -- "$raw"
  record "$gate" "$status" "$code" "$elapsed" "$skips" "$note" "$started_utc" "$ended_utc"
  [[ "$code" -eq 0 ]]
}
# Return success only if the fixed Playwright fixture port has no listener.
# Playwright's webServer then performs its own /login HTTP readiness check.
LOOPBACK_PORT_PROBE_JS='
  const net = require("node:net");
  const socket = net.connect({host:"127.0.0.1",port:3399});
  socket.setTimeout(2000);
  socket.on("connect",()=>{ console.error("Port 3399 is already listening; refusing to reuse an unknown server"); socket.destroy(); process.exitCode=1; });
  socket.on("timeout",()=>{ console.error("Port 3399 readiness probe timed out"); socket.destroy(); process.exitCode=1; });
  socket.on("error",(err)=>{ if (err.code!=="ECONNREFUSED") { console.error("Loopback probe failed:",err.code); process.exitCode=1; } });
'
loopback_port_free() {
  "$NODE_BIN_REAL" -e "$LOOPBACK_PORT_PROBE_JS"
}
# Never kill an unrelated service. Only a listening process in this exact
# worktree whose argv is the Playwright test fixture is eligible for cleanup.
cleanup_own_e2e_listener() {
  command -v fuser >/dev/null 2>&1 || return 0
  local pid cmd cwd attempt
  for pid in $(fuser -n tcp 3399 2>/dev/null || true); do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    if [[ "$cwd" == "$ROOT" && "$cmd" == *"tests/e2e/fixtures/start-test-server.js"* ]]; then
      kill -TERM "$pid" 2>/dev/null || true
      printf 'Stopped owned leftover Playwright fixture PID %s\n' "$pid"
    else
      printf 'Refusing to kill non-fixture port-3399 process %s\n' "$pid" >&2
      return 1
    fi
  done
  for (( attempt=0; attempt<10; attempt++ )); do
    if loopback_port_free >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  printf 'Port 3399 did not clear after owned fixture cleanup\n' >&2
  return 1
}
has_go() {
  command -v go >/dev/null 2>&1 || return 1
  local v major minor
  v="$(printf '%s\n' "$GO_VERSION" | sed -nE 's/.* go([0-9]+)\.([0-9]+)(\.[0-9]+)?.*/\1 \2/p')"
  [[ "$v" =~ ^[0-9]+\ [0-9]+$ ]] || return 1
  read -r major minor <<< "$v"
  (( major > 1 || (major == 1 && minor >= 24) ))
}
has_node() {
  command -v node >/dev/null 2>&1 &&
  command -v npm >/dev/null 2>&1 &&
  [[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 ]]
}
if find "$ROOT/.github/workflows" -type f 2>/dev/null | grep -q .; then
  omit workflow_removal FAIL 'workflow files still present in this worktree'
else
  record workflow_removal PASS 0 0 0 'no Actions YAML files remain in worktree'
fi
if ! command -v timeout >/dev/null 2>&1; then
  die 'coreutils timeout is required; no host packages will be installed'
fi

if has_node; then
  if run npm_ci 600 'lockfile installation in this local worktree' npm ci; then npm_ok=1; else npm_ok=0; fi
else
  npm_ok=0
  omit npm_ci SKIP 'Node 22.x and npm are required; install via authorized host procedure'
fi
for script in typecheck lint lint:typed format:check quality:check build; do
  gate="npm_${script//[:]/_}"; gate="${gate//[-]/_}"
  if (( npm_ok )); then
    if run "$gate" 600 "npm run $script" npm run "$script"; then
      if [[ "$script" == build ]]; then build_ok=1; fi
    else
      if [[ "$script" == build ]]; then build_ok=0; fi
    fi
  else
    omit "$gate" NOT_TESTED 'requires successful npm ci'
    [[ "$script" == build ]] && build_ok=0
  fi
done

if (( npm_ok )); then
  run npm_test 900 'npm test includes its own build; TAP skip count is retained' npm test || true
else
  omit npm_test NOT_TESTED 'requires successful npm ci'
fi
if (( npm_ok )) && (( build_ok )); then
  if run playwright_port_preflight 15 '127.0.0.1:3399 must be unoccupied before Playwright webServer readiness' "$NODE_BIN_REAL" -e "$LOOPBACK_PORT_PROBE_JS"; then
    if run npm_test_e2e 900 'Playwright fixture at 127.0.0.1:3399; first attempt is permanent evidence' npm run test:e2e; then
      # Normally Playwright tears the fixture down; check for leaked processes.
      cleanup_own_e2e_listener || record playwright_cleanup FAIL 1 0 0 'owned fixture cleanup failed or foreign port owner detected'
    else
      # Only the well-defined transient qualifies for one fresh attempt.
      # The original FAIL and its redacted log are NEVER overwritten.
      if grep -q 'ERR_NETWORK_CHANGED' "$REPORT/logs/npm_test_e2e.log"; then
        if cleanup_own_e2e_listener && loopback_port_free; then
          run npm_test_e2e_retry 900 'one bounded retry after preserved ERR_NETWORK_CHANGED failure; overall result remains FAIL' npm run test:e2e || true
          cleanup_own_e2e_listener || record playwright_cleanup FAIL 1 0 0 'post-retry fixture cleanup failed'
        else
          omit npm_test_e2e_retry NOT_TESTED 'transient detected but fixture port could not be safely recovered'
        fi
      else
        cleanup_own_e2e_listener || record playwright_cleanup FAIL 1 0 0 'post-failure fixture cleanup failed'
        omit npm_test_e2e_retry NOT_TESTED 'initial browser failure was not ERR_NETWORK_CHANGED; no retry'
      fi
    fi
  else
    omit npm_test_e2e NOT_TESTED 'port 3399 occupied or loopback probe failed; foreign listeners are never killed'
    omit npm_test_e2e_retry NOT_TESTED 'initial browser attempt not started'
  fi
else
  omit playwright_port_preflight NOT_TESTED 'requires successful npm ci and build'
  omit npm_test_e2e NOT_TESTED 'requires successful npm ci and build'
  omit npm_test_e2e_retry NOT_TESTED 'initial browser attempt not started'
fi

if (( npm_ok )) && (( build_ok )); then
  run railway_script_syntax 60 'local shell syntax; no provisioning' \
    bash -c 'sh -n docker-entrypoint-railway.sh && bash -n scripts/verify-railway-docker-isolation.sh && sh -n scripts/sign-worker-manifest.sh && node --check scripts/verify-railway-sandbox-child.cjs && node --check scripts/verify-railway-offvolume-restore.cjs && node --check scripts/check-railway-pr-stack.mjs' || true
  run railway_pr_stack 240 'synthetic ancestry only; no git fetch' \
    node --test dist/tests/railway-pr-stack.test.js || true
  run railway_sqlite 300 'local SQLite and Railway config checks' \
    node --test dist/tests/railway-sqlite-quickstart.test.js dist/tests/railway-platform-config.test.js || true
  run railway_recovery 420 'two local Node instances and backup/restore' \
    node --test --test-concurrency=1 dist/tests/railway-instance-isolation.test.js dist/tests/railway-disaster-recovery.test.js || true
  run signing_offline 360 'ephemeral signing fixtures only; no release key or publication' \
    node --test dist/tests/worker-signed-release.test.js || true
else
  for gate in railway_script_syntax railway_pr_stack railway_sqlite railway_recovery signing_offline; do
    omit "$gate" NOT_TESTED 'requires npm dependencies and successful build'
  done
fi

if (( npm_ok )); then
  if run railway_sdk_ci 600 'Railway SDK dependencies installed only in .railway' \
    npm ci --prefix .railway --ignore-scripts; then
    run railway_sdk_types 300 'offline TypeScript source validation' \
      ./node_modules/.bin/tsc --noEmit --skipLibCheck --module NodeNext \
      --moduleResolution NodeNext --target ES2022 --allowImportingTsExtensions \
      .railway/railway.ts .railway/validate.ts || true
    run railway_sdk_graph 300 'offline SDK graph validation; NEVER run railway plan/apply' \
      ./.railway/node_modules/.bin/tsx .railway/validate.ts || true
  else
    omit railway_sdk_types NOT_TESTED 'Railway SDK dependency install failed'
    omit railway_sdk_graph NOT_TESTED 'Railway SDK dependency install failed'
  fi
else
  for gate in railway_sdk_ci railway_sdk_types railway_sdk_graph; do
    omit "$gate" NOT_TESTED 'requires successful root npm ci'
  done
fi

if has_go; then
  run go_test 600 'offline module cache; GOTOOLCHAIN=local; GOPROXY=off' \
    bash -c 'cd worker-go && go test ./...' || true
  run go_test_race 900 'Linux race detector; local toolchain' \
    bash -c 'cd worker-go && go test -race ./...' || true
  run go_vet 420 'static analysis with local toolchain' \
    bash -c 'cd worker-go && go vet ./...' || true
  run go_build 600 'output stays in private local evidence directory' \
    bash -c 'cd worker-go && go build -trimpath -o "$1" .' _ "$REPORT/worker-local" || true
else
  for gate in go_test go_test_race go_vet go_build; do
    omit "$gate" SKIP 'Go >=1.24 unavailable; no auto-download/global installation'
  done
fi
if has_go && (( npm_ok )) && (( build_ok )) && command -v openssl >/dev/null 2>&1; then
  run railway_wss_oauth 600 'real Go worker, WSS, OAuth PKCE, local loopback only' \
    env BOT_REPORT_W2_T03_GO_E2E=1 node --test dist/tests/railway-worker-wss-e2e.test.js || true
  run railway_go_isolation 600 'two local Go workers with independent SQLite volumes' \
    env BOT_REPORT_W3_T04_GO_E2E=1 node --test dist/tests/railway-instance-isolation-go.test.js || true
else
  omit railway_wss_oauth SKIP 'requires Go >=1.24, OpenSSL, npm ci and build'
  omit railway_go_isolation SKIP 'requires Go >=1.24, OpenSSL, npm ci and build'
fi

IMAGE="mcp-worker-local:$SHORT_SHA"
# Builds always execute on this PC. Offline mode forbids network; an explicit
# online mode only permits Docker to fetch build dependencies, never deploy.
DOCKER_MODE="${LOCAL_VERIFY_DOCKER_MODE:-offline}"
case "$DOCKER_MODE" in offline|online) ;; *) die 'LOCAL_VERIFY_DOCKER_MODE must be offline or online' ;; esac
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  omit docker_local_build SKIP 'Docker CLI/daemon unavailable'
  docker_ok=0
elif [[ "$DOCKER_MODE" == offline ]] && (
  ! docker image inspect 'node:22.22.3-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd' >/dev/null 2>&1 ||
  ! docker image inspect 'golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804' >/dev/null 2>&1
); then
  omit docker_local_build SKIP 'pinned Docker images not cached; use explicitly authorized online mode if appropriate'
  docker_ok=0
else
  build_args=(--pull=false)
  if [[ "$DOCKER_MODE" == offline ]]; then build_args+=(--network=none); fi
  if run docker_local_build 1200 "Local Docker build ($DOCKER_MODE); never deploy" \
    docker build "${build_args[@]}" \
      --build-arg "BOT_REPORT_GIT_SHA=$HEAD_SHA" \
      --build-arg "BOT_REPORT_TREE_SHA=$(git -C "$ROOT" rev-parse "$HEAD_SHA^{tree}")" \
      --build-arg "BOT_REPORT_BUILD_TIME=$(git -C "$ROOT" show -s --format=%cI "$HEAD_SHA")" \
      -f Dockerfile.railway -t "$IMAGE" .; then
    docker_ok=1
  else
    docker_ok=0
  fi
fi
if (( docker_ok )) && (( npm_ok )) && (( build_ok )); then
  run railway_oci_provenance 120 'source SHA and Git tree must equal the exact PC-built image labels; registry still NOT_TESTED' \
    bash scripts/verify-oci-image-local.sh "$IMAGE" || true
  run railway_docker_config 900 'disposable Docker containers and volumes only' \
    env RAILWAY_DOCKER_INTEGRATION=1 RAILWAY_TEST_IMAGE="$IMAGE" \
    node --test dist/tests/railway-platform-config-docker.test.js || true
  run railway_docker_isolation 1200 'disposable volumes; backup/restore; read-only denial' \
    env W3_SANDBOX_ONLY=1 bash scripts/verify-railway-docker-isolation.sh "$IMAGE" || true
  run railway_offsite_encrypted 900 'five disposable PC volumes and authenticated AES-GCM/HMAC restore; remote backup NOT_TESTED' \
    env T04_LOCAL_TEST_ONLY=1 bash scripts/test-t4-offsite-docker.sh "$IMAGE" || true
else
  omit railway_oci_provenance SKIP 'requires freshly built local Docker image and committed source'
  omit railway_docker_config SKIP 'requires freshly built local Docker image and compiled tests'
  omit railway_docker_isolation SKIP 'requires freshly built local Docker image and compiled tests'
  omit railway_offsite_encrypted SKIP 'requires freshly built local Docker image and compiled tests'
fi

# These previous CI actions require external resources, approval, or a platform
# matrix. Explicitly disclose coverage gaps rather than imply they ran.
omit remote_pr_ancestry NOT_TESTED 'live GitHub ref refresh excluded from offline PC verification'
omit remote_audit NOT_TESTED 'npm audit needs registry access; offline gate not claimed'
omit release_scan NOT_TESTED 'release-verify/SBOM require external image and release prerequisites'
omit cross_os_matrix NOT_TESTED 'only Linux x86_64 PC was available'
{
  printf 'ended_utc=%s\n' "$(date -u +%FT%TZ)"
  printf 'status_counts:\n'
  awk -F '\t' 'NR>1 { n[$2]++ } END {for (s in n) printf "%s=%d\n",s,n[s]}' "$RESULTS" | sort
} >> "$REPORT/metadata.txt"
printf '\nSummary by status (see results.tsv and sanitized logs):\n'
awk -F '\t' 'NR>1 { n[$2]++ } END {for (s in n) printf "%s=%d\n",s,n[s]}' "$RESULTS" | sort
printf 'Evidence path: %s\n' "$REPORT"
if awk -F '\t' 'NR>1 && $2=="FAIL" { found=1 } END {exit !found}' "$RESULTS"; then exit 1; fi
if awk -F '\t' 'NR>1 && ($2=="SKIP" || $2=="NOT_TESTED") { found=1 } END {exit !found}' "$RESULTS"; then exit 3; fi
exit 0
