#!/bin/sh
# Explicit PC-only standalone/MySQL release-candidate integration; never use deployed resources.
# Full Docker builds may require external upstream dependencies: opt in separately.
set -eu
[ -z "${CI:-}" ] && [ -z "${GITHUB_ACTIONS:-}" ] || { echo 'REFUSED: CI forbidden for this PC execution' >&2; exit 2; }
[ "${T5_ALLOW_RELEASE_FULL:-0}" = 1 ] && [ "${T5_ALLOW_RELEASE_NETWORK_BUILD:-0}" = 1 ] || {
  echo 'NOT_TESTED: standalone Docker build requires separately authorized T5_ALLOW_RELEASE_FULL=1 and T5_ALLOW_RELEASE_NETWORK_BUILD=1' >&2; exit 3;
}
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || {
  echo 'NOT_TESTED: local Docker daemon unavailable' >&2; exit 3;
}
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo 'Commit source before release verification.' >&2; exit 1; }
SHA=$(git rev-parse HEAD)
TREE=$(git rev-parse HEAD^{tree})
export BOT_REPORT_GIT_SHA="$SHA" BOT_REPORT_TREE_SHA="$TREE"
BOT_REPORT_BUILD_TIME=$(git show -s --format=%cI HEAD)
export BOT_REPORT_BUILD_TIME
ID="br-release-$(openssl rand -hex 6)"
ENVFILE=".env.setup-$ID"
PORT="${BOT_REPORT_RELEASE_PORT:-13336}"
IMAGE="$ID-app:local"
MYSQL="$ID-mysql:local"
GO_IMAGE="golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804"
OUT="${BOT_REPORT_RELEASE_OUT:-$ROOT/reports/$ID}"
mkdir -p "$OUT"
TEST_TMP=$(mktemp -d)
export BOT_REPORT_SETUP_ENV="$ENVFILE" BOT_REPORT_SETUP_PROJECT="$ID" BOT_REPORT_SETUP_PORT="$PORT"
compose() { docker compose --env-file "$ENVFILE" -p "$ID" -f docker-compose.yml "$@"; }
cleanup() {
  docker rm -fv "$ID-run" "$ID-db" "$ID-builder" "$ID-test-builder" >/dev/null 2>&1 || true
  docker image rm "$ID-test:local" >/dev/null 2>&1 || true
  docker network rm "$ID-net" >/dev/null 2>&1 || true
  if [ -f "$ENVFILE" ]; then compose down -v >/dev/null 2>&1 || true; fi
  rm -f "$ENVFILE" "$ENVFILE.lock"
  rm -rf "$TEST_TMP"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
start=$(date +%s)
./setup.sh --init >"$OUT/setup.log" 2>&1
echo "Fresh setup elapsed seconds: $(($(date +%s)-start))" | tee "$OUT/timing.txt"
# Build tests once in the isolated builder, then put only compiled fixtures into
# temporary verification containers. The production image never contains tests.
docker build --target builder -t "$ID-test:local" . >"$OUT/test-build.log" 2>&1
docker create --name "$ID-test-builder" "$ID-test:local" >/dev/null
docker cp "$ID-test-builder":/app/dist/tests "$TEST_TMP/"
APP_CONTAINER=$(compose ps -q bot-report)
[ -n "$APP_CONTAINER" ]
docker cp "$TEST_TMP/tests" "$APP_CONTAINER":/app/dist/
compose exec -T -e BOT_REPORT_STANDALONE_SMOKE=1 bot-report node dist/tests/standalone-install-smoke.js seed
hash=$(sha256sum "$ENVFILE" | cut -d' ' -f1)
./setup.sh --down
./setup.sh --init >"$OUT/restart.log" 2>&1
[ "$hash" = "$(sha256sum "$ENVFILE" | cut -d' ' -f1)" ]
APP_CONTAINER=$(compose ps -q bot-report)
[ -n "$APP_CONTAINER" ]
docker cp "$TEST_TMP/tests" "$APP_CONTAINER":/app/dist/
compose exec -T -e BOT_REPORT_STANDALONE_SMOKE=1 bot-report node dist/tests/standalone-install-smoke.js verify
docker run --rm --entrypoint sh "$IMAGE" -c 'cd /app/worker/bin && sha256sum -c SHA256SUMS && cat WORKER_RELEASE && ./bot-report-worker-linux-amd64 version' | tee "$OUT/worker-checksums.txt"
docker network create "$ID-net" >/dev/null
pass=$(openssl rand -hex 24)
docker run -d --name "$ID-db" --network "$ID-net" -e MYSQL_ROOT_PASSWORD="$pass" -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=bot_report_test "$MYSQL" >/dev/null
docker run -d --name "$ID-run" --network "$ID-net" --user root --entrypoint sh "$IMAGE" -c 'sleep 3600' >/dev/null
# Compile the typed tests in the same builder used for the production image.
# Keep test files out of the production image; supply them only to
# this isolated verification container.
docker cp "$TEST_TMP/tests" "$ID-run":/app/dist/
docker cp README.md "$ID-run":/app/README.md
rm -rf "$TEST_TMP/tests"
docker exec "$ID-run" apk add --no-cache curl git bash ripgrep openssl >"$OUT/test-prerequisites.log" 2>&1
# Build a distinct fixture from the same source, never from a production worker.
docker create --name "$ID-builder" --entrypoint sh "$GO_IMAGE" -c 'cd /src && CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=2.3.4 -X main.commit=release-test-alternate" -o /tmp/alternate .' >/dev/null
docker cp worker-go/. "$ID-builder":/src
docker start -a "$ID-builder" >"$OUT/alternate-build.log" 2>&1
docker cp "$ID-builder":/tmp/alternate "$OUT/alternate"
docker cp "$OUT/alternate" "$ID-run":/tmp/alternate
rm -f "$OUT/alternate"
i=0
until docker exec -e MYSQL_PWD="$pass" "$ID-db" mysql -uroot -Nse 'SELECT 1' >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -lt 60 ] || exit 1; sleep 2
done
docker exec -e NODE_ENV=test -e BOT_REPORT_ISOLATED_WORKER_TEST=1 -e MYSQL_TEST_HOST="$ID-db" -e MYSQL_TEST_PASSWORD="$pass" -e BOT_REPORT_WORKER_UPGRADE_FIXTURE=/tmp/alternate "$ID-run" sh -c 'cd /app && node --test --test-concurrency=1 dist/tests/*.test.js' >"$OUT/regression.log" 2>&1 || {
  tail -100 "$OUT/regression.log" >&2
  exit 1
}
tail -12 "$OUT/regression.log"
# A passing process exit with conditional tests skipped is incomplete coverage.
REGRESSION_SKIPS=$(sed -n 's/^[[:space:]]*# skipped \([0-9][0-9]*\).*$/\1/p' "$OUT/regression.log" | tail -1)
[ "${REGRESSION_SKIPS:-0}" = 0 ] || {
  echo "NOT_TESTED: mandatory Node regression contains $REGRESSION_SKIPS conditional TAP skips" >&2; exit 3;
}
# Signed native Linux fixture is self-hosted on ephemeral loopback, with
# dynamically generated test-only SPKI/signatures and two offline Go builds.
GOPROXY=off GOTOOLCHAIN=auto node scripts/test-linux-installer-lifecycle.cjs >"$OUT/linux-installer-lifecycle.log" 2>&1
tail -8 "$OUT/linux-installer-lifecycle.log"
printf '%s\n' "$SHA" >"$OUT/commit.txt"
printf '%s\n' "$IMAGE" >"$OUT/image.txt"
printf '%s\n' "$MYSQL" >"$OUT/mysql-image.txt"
bash scripts/verify-oci-image-local.sh "$IMAGE" standalone > "$OUT/image-identity.txt"
echo "LOCAL_STANDALONE_PRELIMINARY_PASS: source=$SHA tree=$TREE evidence=$OUT"
echo 'NOT_TESTED: independent supply chain SBOM/Trivy, browser, native OS, offsite restore, external Railway; release remains NO_GO'
