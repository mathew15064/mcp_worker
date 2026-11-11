#!/bin/sh
# Disposable local/CI verification. Never run against a deployed database/Worker.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo 'Commit source before release verification.' >&2; exit 1; }
SHA=$(git rev-parse HEAD)
ID="br-release-$(openssl rand -hex 6)"
ENVFILE=".env.setup-$ID"
PORT="${BOT_REPORT_RELEASE_PORT:-13336}"
IMAGE="$ID-app:local"
MYSQL="$ID-mysql:local"
GO_IMAGE="golang:1.26.10-alpine@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696"
OUT="${BOT_REPORT_RELEASE_OUT:-$ROOT/reports/$ID}"
mkdir -p "$OUT"
export BOT_REPORT_SETUP_ENV="$ENVFILE" BOT_REPORT_SETUP_PROJECT="$ID" BOT_REPORT_SETUP_PORT="$PORT"
compose() { docker compose --env-file "$ENVFILE" -p "$ID" -f docker-compose.yml "$@"; }
cleanup() {
  docker rm -fv "$ID-run" "$ID-db" "$ID-builder" >/dev/null 2>&1 || true
  docker network rm "$ID-net" >/dev/null 2>&1 || true
  if [ -f "$ENVFILE" ]; then compose down -v >/dev/null 2>&1 || true; fi
  rm -f "$ENVFILE" "$ENVFILE.lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
start=$(date +%s)
./setup.sh --init >"$OUT/setup.log" 2>&1
echo "Fresh setup elapsed seconds: $(($(date +%s)-start))" | tee "$OUT/timing.txt"
compose exec -T -e BOT_REPORT_STANDALONE_SMOKE=1 bot-report node - seed < tests/standalone-install-smoke.js
hash=$(sha256sum "$ENVFILE" | cut -d' ' -f1)
./setup.sh --down
./setup.sh --init >"$OUT/restart.log" 2>&1
[ "$hash" = "$(sha256sum "$ENVFILE" | cut -d' ' -f1)" ]
compose exec -T -e BOT_REPORT_STANDALONE_SMOKE=1 bot-report node - verify < tests/standalone-install-smoke.js
docker run --rm --entrypoint sh "$IMAGE" -c 'cd /app/worker/bin && sha256sum -c SHA256SUMS && cat WORKER_RELEASE && ./bot-report-worker-linux-amd64 version' | tee "$OUT/worker-checksums.txt"
docker network create "$ID-net" >/dev/null
pass=$(openssl rand -hex 24)
docker run -d --name "$ID-db" --network "$ID-net" -e MYSQL_ROOT_PASSWORD="$pass" -e MYSQL_ROOT_HOST=% -e MYSQL_DATABASE=bot_report_test "$MYSQL" >/dev/null
docker run -d --name "$ID-run" --network "$ID-net" --user root --entrypoint sh "$IMAGE" -c 'sleep 3600' >/dev/null
docker cp tests "$ID-run":/app/
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
docker exec -e NODE_ENV=test -e BOT_REPORT_ISOLATED_WORKER_TEST=1 -e MYSQL_TEST_HOST="$ID-db" -e MYSQL_TEST_PASSWORD="$pass" -e BOT_REPORT_WORKER_UPGRADE_FIXTURE=/tmp/alternate "$ID-run" sh -c 'cd /app && npm test' >"$OUT/regression.log" 2>&1
tail -12 "$OUT/regression.log"
printf '%s\n' "$SHA" >"$OUT/commit.txt"
printf '%s\n' "$IMAGE" >"$OUT/image.txt"
printf '%s\n' "$MYSQL" >"$OUT/mysql-image.txt"
docker image inspect "$IMAGE" --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' >"$OUT/image-identity.txt"
echo "PASS isolated release verification; evidence: $OUT"
