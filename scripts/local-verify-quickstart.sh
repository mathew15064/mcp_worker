#!/usr/bin/env bash
# T5 Wave 3 PC-local QA: no downloads, installs, CI, cloud, signing, commits or publication.
# --targeted is quick and honest; --full attempts mandatory gates only with explicit sandboxes.
set -uo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 2
MODE="${1:---targeted}"
[[ "$MODE" == --targeted || "$MODE" == --full ]] || { echo "Usage: $0 [--targeted|--full]" >&2; exit 2; }
[[ -z "${CI:-}" && -z "${GITHUB_ACTIONS:-}" ]] || { echo "PC-local only; CI prohibited" >&2; exit 2; }
BRANCH="$(git branch --show-current)"
[[ "$(git rev-parse --show-toplevel)" == "$ROOT" ]] || {
  echo "PC-local source checkout does not match script directory" >&2
  exit 2
}
QA_SCOPE=LOCAL_PC
BASE="$(git rev-parse HEAD)"
TREE="$(git rev-parse 'HEAD^{tree}')"
if [[ -n "${T5_EXPECTED_SHA:-}" && "$BASE" != "$T5_EXPECTED_SHA" ]] ||
   [[ -n "${T5_EXPECTED_TREE:-}" && "$TREE" != "$T5_EXPECTED_TREE" ]]; then
  echo "SOURCE_DRIFT: commit/tree differs from reviewed source" >&2
  exit 2
fi
OUT="${T5_QA_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/t5-qa.XXXXXXXX")}"
mkdir -p -m 700 "$OUT" || exit 2
RESULTS="$OUT/results.tsv"
printf "gate\tmandatory\tstatus\texit_code\ttest_pass\ttest_fail\ttest_skip\tprerequisites_or_note\n" > "$RESULTS"
printf "run=PC-LOCAL-%s\ntask=T5\nbase=%s\ntree=%s\nbranch=%s\nmode=%s\ndiff_sha256=%s\n" "${BASE:0:12}" "$BASE" "$TREE" "$BRANCH" "$MODE" "$(git diff --binary | sha256sum | cut -d\  -f1)" > "$OUT/context.txt"
FAIL=0
record() {
  local name="$1" mandatory="$2" status="$3" exit_code="$4" pass="$5" fail="$6" skip="$7" note="$8"
  note="${note//$'\t'/ }"; note="${note//$'\n'/ }"
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$name" "$mandatory" "$status" "$exit_code" "$pass" "$fail" "$skip" "$note" >> "$RESULTS"
  printf "T5_GATE %s status=%s exit=%s test_pass/fail/skip=%s/%s/%s %s\n" "$name" "$status" "$exit_code" "$pass" "$fail" "$skip" "$note"
}
missing() { record "$1" "$2" NOT_TESTED "-" 0 0 0 "$3"; }
# Every command executes once; on a failed command later runnable gates are withheld.
# A green exit with TAP skips is PARTIAL (optional) or NOT_TESTED (mandatory).
run() {
  local name="$1" required="$2" note="$3"; shift 3
  if (( FAIL )); then missing "$name" "$required" "stopped after prior command failure"; return 0; fi
  local raw code pass fail skip status
  raw="$(mktemp "$OUT/.raw.XXXXXXXX")" || exit 2
  "$@" > "$raw" 2>&1; code=$?
  pass="$(sed -n -E "s/^[[:space:]]*# pass ([0-9]+).*/\1/p" "$raw" | tail -1)"; pass="${pass:-0}"
  fail="$(sed -n -E "s/^[[:space:]]*# fail ([0-9]+).*/\1/p" "$raw" | tail -1)"; fail="${fail:-0}"
  skip="$(sed -n -E "s/^[[:space:]]*# skipped ([0-9]+).*/\1/p" "$raw" | tail -1)"; skip="${skip:-0}"
  # Playwright reports its own test counts, not Node TAP. Count test.skip
  # independently and refuse a zero-discovery "successful" browser command.
  if [[ "$name" == playwright_browser ]]; then
    pass="$(grep -oE '[0-9]+ passed' "$raw" | tail -1 | cut -d' ' -f1 || true)"; pass="${pass:-0}"
    skip="$(grep -oE '[0-9]+ skipped' "$raw" | tail -1 | cut -d' ' -f1 || true)"; skip="${skip:-0}"
    if [[ "$pass" -eq 0 ]]; then code=1; fi
  fi
  if [[ "$code" -ne 0 || "$fail" -gt 0 ]]; then status=FAIL; FAIL=1
    # Bounded output; suppress lines that might expose sandbox secrets.
    grep -Ei "^(not ok|# fail|# tests|# skipped|error:|fail |npm error)" "$raw" | tail -20 | cut -c 1-240 >&2 || true
  elif [[ "$skip" -gt 0 ]]; then
    if [[ "$required" == yes ]]; then status=NOT_TESTED; else status=PARTIAL; fi
  else status=PASS; fi
  rm -f "$raw"
  record "$name" "$required" "$status" "$code" "$pass" "$fail" "$skip" "$note"
}
command -v node >/dev/null 2>&1 || { echo "Node unavailable" >&2; exit 2; }
run script_syntax yes "node --check; bash/sh -n; no source builds" bash -c 'node --check scripts/test-linux-installer-lifecycle.cjs && node --check scripts/quality-gate.mjs && bash -n scripts/local-verify-quickstart.sh scripts/verify-oci-image-local.sh && sh -n scripts/release-scan.sh'
NODE_VERSION="$(node -v)"
NPM_VERSION="$(npm -v 2>/dev/null || echo missing)"
GO_BIN=""
if command -v go >/dev/null 2>&1; then
  GOROOT_LOCAL="$(cd worker-go && GOTOOLCHAIN=auto GOPROXY=off go env GOROOT 2>/dev/null || true)"
  if [[ -x "$GOROOT_LOCAL/bin/go" ]] && "$GOROOT_LOCAL/bin/go" version 2>/dev/null | grep -Eq " go1[.]24[.]"; then GO_BIN="$GOROOT_LOCAL/bin/go"; fi
fi
printf "node=%s\nnpm=%s\ngo=%s\ndocker=%s\n" "$NODE_VERSION" "$NPM_VERSION" "${GO_BIN:-NOT_AVAILABLE_GO_1_24_OFFLINE}" "$(docker --version 2>/dev/null || echo NOT_AVAILABLE)" >> "$OUT/context.txt"
if [[ "$NODE_VERSION" != v22.* ]]; then
  missing node_quality yes "Node 22 required; got $NODE_VERSION"
  missing node_build yes "Node 22 required"
  NODE_OK=0
elif [[ ! -d node_modules || ! -x node_modules/.bin/tsc ]]; then
  missing node_quality yes "node_modules absent; use authorized cached npm ci separately (no automatic download)"
  missing node_build yes "node_modules absent"
  NODE_OK=0
else
  run node_quality yes "typecheck + typed lint + Prettier + quality baseline" bash -c 'npm run typecheck && npm run lint:typed && npm run format:check && node scripts/quality-gate.mjs check'
  run node_build yes "compile once for targeted tests; do not rebuild for each gate" npm run build
  NODE_OK=$((1-FAIL))
fi
# Non-root recovery uses only a disposable read-only app copy, because cached
# host npm dependencies can be root-readable-only. Never chmod the source tree.
recovery_nonroot_docker() {
  local stage rc=0
  stage="$(mktemp -d "$OUT/.recovery-nonroot.XXXXXXXX")" || return 1
  if ! mkdir -p "$stage/app" || ! cp -a dist "$stage/app/dist" || \
     ! cp -a "$(realpath node_modules)" "$stage/app/node_modules" || \
     ! cp -a scripts "$stage/app/scripts" || \
     ! cp package.json "$stage/app/package.json" || \
     ! chmod -R a+rX "$stage/app"; then
    rm -rf "$stage"
    return 1
  fi
  docker run --rm --pull=never --network=none \
    --user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges \
    --read-only --tmpfs /tmp:rw,mode=1777,size=512m --pids-limit=256 --memory=2g \
    --mount "type=bind,source=$stage/app,target=/app,readonly" \
    --workdir /app -e NODE_ENV=test node:22 \
    node --test --test-concurrency=1 \
      dist/tests/railway-disaster-recovery.test.js \
      dist/tests/railway-instance-isolation.test.js || rc=$?
  rm -rf "$stage"
  return "$rc"
}
if (( NODE_OK )); then
  run railway_sqlite yes "SQLite HTTP/OAuth fixture; optional Chromium subtest must count as TAP skip" node --test --test-concurrency=1 dist/tests/railway-sqlite-quickstart.test.js
  run signed_release_unit yes "test-only signer, canonical inventory and negative trust" node --test --test-concurrency=1 dist/tests/worker-signed-release.test.js
  if [[ "$MODE" == --full && "${T5_RECOVERY_NONROOT_CONTAINER_TEST:-0}" == 1 ]]; then
    if command -v docker >/dev/null && docker info >/dev/null 2>&1 && docker image inspect node:22 >/dev/null 2>&1; then
      run railway_recovery yes "cached Node22 non-root Docker; offline SQLite backup/restore, no root skip" recovery_nonroot_docker
    else
      missing railway_recovery yes "non-root recovery opt-in requires Docker and cached node:22"
    fi
  else
    run railway_recovery yes "local SQLite backup/restore; root-only permissions test may skip" node --test --test-concurrency=1 dist/tests/railway-disaster-recovery.test.js dist/tests/railway-instance-isolation.test.js
  fi
else
  missing railway_sqlite yes "compiled tests require working Node 22 dependencies"
  missing signed_release_unit yes "compiled signed tests unavailable"
  missing railway_recovery yes "compiled recovery tests unavailable"
fi
if [[ "$MODE" == --full ]]; then
  if (( NODE_OK )) && [[ -n "$GO_BIN" ]] && command -v openssl >/dev/null; then
    run linux_installer_lifecycle yes "ephemeral RSA SPKI, nine signed entries, two offline Go builds; unprivileged loopback only" env PATH="$(dirname "$GO_BIN"):$PATH" GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local node scripts/test-linux-installer-lifecycle.cjs
  else missing linux_installer_lifecycle yes "Node build, Go 1.24 cached, OpenSSL required; no external staging"; fi
  if [[ -n "$GO_BIN" ]]; then
    run go_test yes "Go1.24 module; GOPROXY=off" bash -c 'cd worker-go && GOTOOLCHAIN=local GOPROXY=off "$1" test ./...' _ "$GO_BIN"
    run go_race yes "Go1.24 race detector; GOPROXY=off" bash -c 'cd worker-go && GOTOOLCHAIN=local GOPROXY=off "$1" test -race ./...' _ "$GO_BIN"
    run go_vet yes "Go1.24 vet; GOPROXY=off" bash -c 'cd worker-go && GOTOOLCHAIN=local GOPROXY=off "$1" vet ./...' _ "$GO_BIN"
  else
    for gate in go_test go_race go_vet; do missing "$gate" yes "offline Go1.24 toolchain missing"; done
  fi
  if (( NODE_OK )) && [[ -n "$GO_BIN" ]] && command -v openssl >/dev/null; then
    run wss_worker yes "real localhost WSS, Go Worker, OAuth PKCE" env PATH="$(dirname "$GO_BIN"):$PATH" GOPROXY=off GOTOOLCHAIN=local BOT_REPORT_W2_T03_GO_E2E=1 node --test dist/tests/railway-worker-wss-e2e.test.js
    run go_isolation yes "two Go Workers in isolated SQLite local sandboxes" env PATH="$(dirname "$GO_BIN"):$PATH" GOPROXY=off GOTOOLCHAIN=local BOT_REPORT_W3_T04_GO_E2E=1 node --test dist/tests/railway-instance-isolation-go.test.js
  else missing wss_worker yes "requires built Node tests, offline Go1.24 and OpenSSL"; missing go_isolation yes "requires built Node tests, offline Go1.24 and OpenSSL"; fi
  # Worker-live must run in a disposable Node container, never against a
  # host-installed Worker. The original PC source and dependencies are read-only.
  mysql_worker_docker() {
    local deps
    deps="$(realpath node_modules)" || return 1
    mkdir -p dist/worker/bin || return 1
    (cd worker-go && GOTOOLCHAIN=local GOPROXY=off "$GO_BIN" build -o ../dist/worker/bin/bot-report-worker-linux-amd64 .) || return 1
    local mounts=(--mount "type=bind,source=$ROOT,target=$ROOT,readonly")
    if [[ "$deps" != "$ROOT/node_modules" ]]; then
      mounts+=(--mount "type=bind,source=$deps,target=$deps,readonly")
    fi
    docker run --rm --pull=never --network=host \
      --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=256 --memory=2g \
      "${mounts[@]}" \
      --mount type=bind,source="$(command -v rg)",target=/usr/local/bin/rg,readonly \
      --workdir "$ROOT" \
      -e NODE_ENV=test -e MYSQL_TEST_HOST -e MYSQL_TEST_PORT \
      -e MYSQL_TEST_DATABASE -e MYSQL_TEST_USERNAME -e MYSQL_TEST_PASSWORD \
      -e BOT_REPORT_ISOLATED_WORKER_TEST=1 \
      node:22 node --test --test-concurrency=1 dist/tests/worker-live-integration.test.js
  }
  if (( NODE_OK )) && [[ "${T5_MYSQL_SANDBOX:-0}" == 1 ]] && [[ "${MYSQL_TEST_HOST:-}" == 127.0.0.1 || "${MYSQL_TEST_HOST:-}" == localhost ]] && [[ "${MYSQL_TEST_DATABASE:-}" == bot_report_test* ]]; then
    run mysql_integration yes "explicit disposable localhost MySQL schema and credentials" env NODE_ENV=test node --test dist/tests/mysql-integration.test.js
    run mysql_setup_ui yes "same disposable localhost MySQL" env NODE_ENV=test node --test dist/tests/mysql-setup-ui-integration.test.js
    if [[ "${T5_MYSQL_WORKER_CONTAINER_TEST:-0}" == 1 ]] && [[ -n "$GO_BIN" ]] && command -v docker >/dev/null && docker info >/dev/null 2>&1 && docker image inspect node:22 >/dev/null 2>&1 && command -v rg >/dev/null; then
      run mysql_worker_live yes "cached Node22 + git/rg; disposable Docker Worker, read-only source, localhost MySQL" mysql_worker_docker
    else
      missing mysql_worker_live yes "requires T5_MYSQL_WORKER_CONTAINER_TEST=1, Go1.24, Docker, cached node:22, ripgrep and disposable localhost MySQL"
    fi
  else
    for gate in mysql_integration mysql_setup_ui mysql_worker_live; do missing "$gate" yes "requires T5_MYSQL_SANDBOX=1, MYSQL_TEST_HOST=127.0.0.1|localhost, MYSQL_TEST_DATABASE and disposable server; NEVER use production DB"; done
  fi
  if (( NODE_OK )) && [[ "${T5_BROWSER_SANDBOX:-0}" == 1 ]] && node -e "const fs=require('node:fs'); const {chromium}=require('@playwright/test');process.exit(fs.existsSync(chromium.executablePath())?0:1)" >/dev/null 2>&1; then
    run playwright_browser yes "real cached Chromium; no silent green on absence" ./node_modules/.bin/playwright test --config dist/playwright.config.js
  else missing playwright_browser yes "T5_BROWSER_SANDBOX=1 plus executable Playwright Chromium cache and built Node tests required"; fi
  if [[ "${T5_ALLOW_DOCKER_BUILD:-0}" == 1 ]] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && [[ -z "$(git status --porcelain)" ]]; then
    BUILD_NETWORK=none
    [[ "${T5_ALLOW_BUILD_NETWORK:-0}" == 1 ]] && BUILD_NETWORK=default
    STANDALONE="mcp-worker-local:$(git rev-parse --short=12 HEAD)"
    run standalone_build yes "local Docker; pinned Node22 / Go1.26.10 bases, no image pulls" docker build --pull=false --network="$BUILD_NETWORK" -f Dockerfile --build-arg "BOT_REPORT_GIT_SHA=$BASE" --build-arg "BOT_REPORT_TREE_SHA=$TREE" --build-arg "BOT_REPORT_BUILD_TIME=$(git show -s --format=%cI HEAD)" -t "$STANDALONE" .
    run standalone_provenance yes "exact committed SHA/tree, runtime and nonroot entrypoint" bash scripts/verify-oci-image-local.sh "$STANDALONE" standalone
  else
    for gate in standalone_build standalone_provenance; do missing "$gate" yes "needs T5_ALLOW_DOCKER_BUILD=1, clean source, cached bases and local Docker; no silent pulls"; done
  fi
else
  for gate in linux_installer_lifecycle go_test go_race go_vet wss_worker go_isolation mysql_integration mysql_setup_ui mysql_worker_live playwright_browser standalone_build standalone_provenance; do missing "$gate" yes "targeted mode; use --full with exact disposable prerequisites"; done
fi
# Network audit and Trivy are always separately approved and never implicitly executed.
missing dependency_audit yes "npm audit requires explicit approved network access and fresh registry evidence"
missing sbom_trivy yes "cached authorized Trivy image/DB and local OCI images required; run release-scan.sh explicitly"
missing native_other_os yes "native Windows/macOS/systemd matrix is not available on Linux PC"
missing external_mcp yes "external HTTPS and ChatGPT OAuth not checked locally"
missing offsite_restore yes "independent offsite provider not approved"
node - "$RESULTS" "$OUT/summary.json" <<'NODE'
const fs=require("node:fs");
const [input,out]=process.argv.slice(2);
const rows=fs.readFileSync(input,"utf8").trimEnd().split("\n").slice(1).map(l=>{const [gate,mandatory,status,exit_code,tap_pass,tap_fail,tap_skip,note]=l.split("\t");return {gate,mandatory:mandatory==="yes",status,exit_code:exit_code==="-"?null:Number(exit_code),test_counts:{pass:Number(tap_pass),fail:Number(tap_fail),skip:Number(tap_skip)},prerequisites_or_note:note};});
const summary={status:rows.some(x=>x.status==="FAIL")?"FAIL":rows.some(x=>x.mandatory&&x.status!=="PASS")?"NO_GO":"LOCAL_GATES_COMPLETE_REVIEW_REQUIRED",gates:rows};
fs.writeFileSync(out,JSON.stringify(summary,null,2)+"\n");console.log("T5_QA_SUMMARY "+JSON.stringify({status:summary.status,counts:rows.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{})}));
NODE
printf "T5_QA_EVIDENCE=%s (local, no remote upload)\n" "$OUT"
if (( FAIL )); then exit 1; fi
if grep -Eq $'\tyes\t(NOT_TESTED|PARTIAL|SKIP)\t' "$RESULTS"; then exit 3; fi
exit 0
