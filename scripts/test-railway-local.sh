#!/usr/bin/env bash
# Local PC ONLY: disposable Docker verification for Railway + SQLite.
# No Railway CLI, project, public domain, GitHub Actions or CI/CD.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null
command -v curl >/dev/null
command -v node >/dev/null
docker info >/dev/null

image="${1:-mcp-worker-t5-local:$(git rev-parse --short=12 HEAD)}"
if [[ "$#" -eq 0 ]]; then
  [[ "${T5_ALLOW_DOCKER_BUILD:-0}" == 1 ]] || { echo 'NOT_TESTED: explicit T5_ALLOW_DOCKER_BUILD=1 required; never pull images implicitly' >&2; exit 3; }
  [[ -z "$(git status --porcelain)" ]] || { echo 'NOT_TESTED: OCI source must be clean/committed for exact provenance' >&2; exit 3; }
  docker build --pull=false --network=none --progress=plain -f Dockerfile.railway \
    --build-arg "BOT_REPORT_GIT_SHA=$(git rev-parse HEAD)" \
    --build-arg "BOT_REPORT_TREE_SHA=$(git rev-parse HEAD^{tree})" \
    --build-arg "BOT_REPORT_BUILD_TIME=$(git show -s --format=%cI HEAD)" -t "$image" .
  echo "DOCKER_BUILD_PASS image=$image"
else
  docker image inspect "$image" >/dev/null
fi
bash scripts/verify-oci-image-local.sh "$image" railway

prefix="mcp-t3-$(node -e "process.stdout.write(require('node:crypto').randomBytes(7).toString('hex'))")"
container="$prefix-app"
volume="$prefix-sqlite"
other_container="$prefix-isolated"
other_volume="$prefix-isolated-sqlite"
cleanup() {
  docker rm -f "$container" "$other_container" >/dev/null 2>&1 || true
  docker volume rm "$volume" "$other_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
secret="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
common=(-e MCP_PLATFORM=railway -e RAILWAY_VOLUME_MOUNT_PATH=/app/data
  -e DATABASE_PATH=/app/data/bot_report.sqlite -e RAILWAY_VOLUME_NAME="$volume")
expect_failure() {
  local message="$1"; shift
  local result
  if result="$(timeout 30 docker run --rm "$@" 2>&1)"; then
    echo "FAIL: $message unexpectedly started" >&2
    exit 1
  fi
  printf '%s\n' "$result" | grep -Eiq 'RAILWAY_BOOT|permission denied|read-only file system|not a mounted volume' || {
    echo "FAIL: $message did not produce a controlled startup denial" >&2
    exit 1
  }
  echo "PASS: $message refused"
}

# Neither an absent volume nor merely setting Railway env vars is acceptable.
expect_failure missing-volume-identity -e MCP_PLATFORM=railway \
  -e DATABASE_PATH=/app/data/bot_report.sqlite -e RAILWAY_VOLUME_MOUNT_PATH=/app/data \
  -e MCP_SETUP_SECRET="$secret" "$image"
expect_failure forged-volume-vars "${common[@]}" -e MCP_SETUP_SECRET="$secret" "$image"
docker volume create --label io.mcp-worker.t3.disposable=true "$volume" >/dev/null
expect_failure missing-setup-secret -v "$volume:/app/data" "${common[@]}" "$image"
expect_failure weak-setup-secret -v "$volume:/app/data" "${common[@]}" -e MCP_SETUP_SECRET=weak "$image"
expect_failure repeated-setup-secret -v "$volume:/app/data" "${common[@]}" \
  -e MCP_SETUP_SECRET="$(printf 'A%.0s' {1..43})" "$image"
expect_failure noncanonical-setup-secret -v "$volume:/app/data" "${common[@]}" \
  -e MCP_SETUP_SECRET="$(printf 'z%.0s' {1..43})" "$image"
expect_failure wrong-database-path -v "$volume:/app/data" "${common[@]}" \
  -e DATABASE_PATH=/tmp/ephemeral.sqlite -e MCP_SETUP_SECRET="$secret" "$image"
expect_failure wrong-volume-path -v "$volume:/app/data" "${common[@]}" \
  -e RAILWAY_VOLUME_MOUNT_PATH=/app/other -e MCP_SETUP_SECRET="$secret" "$image"
expect_failure nonroot-initializer --user 1000:1000 -v "$volume:/app/data" "${common[@]}" \
  -e MCP_SETUP_SECRET="$secret" "$image"
expect_failure readonly-volume -v "$volume:/app/data:ro" "${common[@]}" -e MCP_SETUP_SECRET="$secret" "$image"
for dbfile in bot_report.sqlite bot_report.sqlite-wal bot_report.sqlite-shm; do
  docker run --rm --entrypoint sh -v "$volume:/app/data" "$image" \
    -c "ln -s /tmp/escape /app/data/$dbfile"
  expect_failure "symlink-$dbfile" -v "$volume:/app/data" "${common[@]}" \
    -e MCP_SETUP_SECRET="$secret" "$image"
  docker run --rm --entrypoint sh -v "$volume:/app/data" "$image" \
    -c "rm /app/data/$dbfile"
done

docker run -d --name "$container" --label io.mcp-worker.t3.disposable=true \
  -p 127.0.0.1::80 -v "$volume:/app/data" "${common[@]}" \
  -e MCP_SETUP_SECRET="$secret" \
  -e RAILWAY_PUBLIC_DOMAIN=t3-local-check.up.railway.app "$image" >/dev/null
# Do not retain the secret beyond Docker launch.
unset secret
port="$(docker port "$container" 80/tcp | sed -n '1s/^.*://p')"
[[ "$port" =~ ^[0-9]+$ ]] || { echo "FAIL: no loopback port" >&2; exit 1; }
probe() {
  local endpoint="$1" want="$2" got active_port
  # Docker may allocate a new published ephemeral host port after restart.
  active_port="$(docker port "$container" 80/tcp | sed -n '1s/^.*://p')"
  [[ "$active_port" =~ ^[0-9]+$ ]] || { echo 'FAIL: no loopback port' >&2; exit 1; }
  for i in {1..45}; do
    got="$(curl --max-time 2 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$active_port$endpoint" || true)"
    [[ "$got" == "$want" ]] && return 0
    sleep 1
  done
  docker logs "$container" 2>&1 | tail -35 >&2
  echo "FAIL: $endpoint expected $want, got ${got:-empty}" >&2
  exit 1
}
verify_sqlite() {
  local expected="$1"
  docker exec -u node "$container" node -e '
    const Database=require("better-sqlite3");
    const db=new Database("/app/data/bot_report.sqlite",{readonly:true,fileMustExist:true});
    if(db.pragma("quick_check",{simple:true})!=="ok")throw Error("SQLite quick_check failed");
    const row=db.prepare("SELECT value FROM system_settings WHERE key=?").get("t3.local.marker");
    if(row?.value!==process.argv[1])throw Error("Persistent SQLite marker mismatch");
    db.close();
  ' "$expected"
}
probe /healthz 200
probe /readyz 503
probe /setup 200
uid="$(docker exec "$container" sh -c "awk '/^Uid:/ {print \$2}' /proc/1/status")"
[[ "$uid" == 1000 ]] || { echo "FAIL: PID1 UID=$uid expected 1000" >&2; exit 1; }
[[ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$container")" == "$volume" ]]
docker exec -u node "$container" node -e '
  const Database=require("better-sqlite3");
  const db=new Database("/app/data/bot_report.sqlite");
  db.prepare("INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,?,?)")
    .run("t3.local.marker","persisted-across-restart",new Date().toISOString());
  if(db.pragma("quick_check",{simple:true})!=="ok")throw Error("SQLite integrity failed");
  db.close();
'
verify_sqlite persisted-across-restart
# A second independently mounted SQLite volume must not see the first owner's
# database marker, even while both isolated containers are running.
docker volume create --label io.mcp-worker.t3.disposable=true "$other_volume" >/dev/null
other_secret="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
docker run -d --name "$other_container" --label io.mcp-worker.t3.disposable=true \
  -v "$other_volume:/app/data" "${common[@]}" \
  -e RAILWAY_VOLUME_NAME="$other_volume" -e MCP_SETUP_SECRET="$other_secret" \
  -e RAILWAY_PUBLIC_DOMAIN=t3-isolated-local.up.railway.app "$image" >/dev/null
unset other_secret
for i in {1..45}; do
  if docker exec "$other_container" node -e "fetch('http://127.0.0.1:80/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$other_container" node -e "fetch('http://127.0.0.1:80/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null
docker exec -u node "$other_container" node -e '
  const Db=require("better-sqlite3");
  const db=new Db("/app/data/bot_report.sqlite",{readonly:true,fileMustExist:true});
  if(db.pragma("quick_check",{simple:true})!=="ok" ||
     db.prepare("SELECT value FROM system_settings WHERE key=?").get("t3.local.marker"))
    process.exitCode=1;
  db.close();
'
verify_sqlite persisted-across-restart
docker restart "$container"  >/dev/null
probe /healthz 200
probe /readyz 503
verify_sqlite persisted-across-restart
[[ "$(docker exec "$container" sh -c "awk '/^Uid:/ {print \$2}' /proc/1/status")" == 1000 ]]
# Confirm the image-defined Docker healthcheck (not just a successful curl).
for i in {1..35}; do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" == healthy ]]
echo 'RAILWAY_DOCKER_LOCAL_PASS: volume=1 restart=PASS uid=1000 sqlite_quick_check=ok healthz=200 readyz=503 docker_health=healthy isolated_volume=PASS missing_mount=DENIED secret=DENIED'
echo 'RAILWAY_LIVE_NOT_TESTED: no Railway resources or public HTTPS were created'
