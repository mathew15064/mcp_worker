#!/usr/bin/env bash
# W3-T04 disposable Docker-only isolation/restore verification.
# This script never addresses Railway or production hosts.
set -euo pipefail
if [[ "${W3_SANDBOX_ONLY:-}" != 1 ]]; then
  echo 'Refusing Docker test without W3_SANDBOX_ONLY=1' >&2; exit 2
fi
image="${1:?Usage: scripts/verify-railway-docker-isolation.sh IMAGE}"
command -v docker >/dev/null
command -v node >/dev/null
command -v curl >/dev/null
docker info >/dev/null
prefix="t04-local-$$-$RANDOM"
a="$prefix-a"; b="$prefix-b"; c="$prefix-c"; ro="$prefix-readonly"
va="$prefix-volume-a"; vb="$prefix-volume-b"; vc="$prefix-volume-restored"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/w3t04-docker-offvolume.XXXXXXXX")"
cleanup() {
  for container in "$a" "$b" "$c" "$ro"; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  for volume in "$va" "$vb" "$vc"; do
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done
  rm -rf -- "$tmp"
}
trap cleanup EXIT
for volume in "$va" "$vb" "$vc"; do
  docker volume create --label t04.disposable=true "$volume" >/dev/null
done
key_a="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
key_b="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
if [[ "$key_a" = "$key_b" ]]; then echo 'Unexpected duplicate secrets' >&2; exit 1; fi
run() {
  local container="$1" volume="$2" secret="$3" domain="$4"
  docker run -d --name "$container" --label t04.disposable=true \
    -p 127.0.0.1::80 -v "$volume:/app/data" \
    -e MCP_PLATFORM=railway -e RAILWAY_VOLUME_NAME="$volume" \
    -e RAILWAY_VOLUME_MOUNT_PATH=/app/data -e DATABASE_PATH=/app/data/bot_report.sqlite \
    -e MCP_SETUP_SECRET="$secret" -e RAILWAY_PUBLIC_DOMAIN="$domain" \
    "$image" >/dev/null
}
probe() {
  local container="$1" endpoint="$2" expected="$3" port code
  port="$(docker port "$container" 80/tcp | head -1 | sed 's/^.*://')"
  [[ "$port" =~ ^[0-9]+$ ]] || { echo 'Missing ephemeral loopback port' >&2; return 1; }
  for i in {1..30}; do
    code="$(curl --max-time 2 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$endpoint" || true)"
    if [[ "$code" = "$expected" ]]; then return 0; fi
    sleep 1
  done
  echo "Local container health probe failed: $container $endpoint" >&2
  return 1
}
run "$a" "$va" "$key_a" "w3-a.sandbox.up.railway.app"
run "$b" "$vb" "$key_b" "w3-b.sandbox.up.railway.app"
unset key_b
probe "$a" /healthz 200
probe "$b" /healthz 200
probe "$a" /setup 200
probe "$b" /setup 200
probe "$a" /readyz 503
probe "$b" /readyz 503
[[ "$(docker port "$a" 80/tcp)" != "$(docker port "$b" 80/tcp)" ]]
[[ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$a")" = "$va" ]]
[[ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$b")" = "$vb" ]]
mark() {
  docker exec -u node "$1" node -e '
    const DB=require("better-sqlite3"), db=new DB("/app/data/bot_report.sqlite");
    db.prepare("INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,?,?)")
      .run("w3.docker.marker",process.argv[1],new Date().toISOString());
    // Disposable Docker fixture only: owner record makes backup validation meaningful.
    // Use a different salted fixture credential in each independent volume.
    if (!db.prepare("SELECT value FROM system_settings WHERE key=?")
          .get("bootstrap.admin_password_hash")) {
      db.prepare("INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,?)")
        .run("bootstrap.admin_password_hash",
          require("bcryptjs").hashSync("docker-fixture-" + process.argv[1], 4),
          new Date().toISOString());
    }
    db.close();
  ' "$2"
}
verify() {
  docker exec -u node "$1" node -e '
    const DB=require("better-sqlite3"), db=new DB("/app/data/bot_report.sqlite",{readonly:true,fileMustExist:true});
    const val=db.prepare("SELECT value FROM system_settings WHERE key=?").get("w3.docker.marker");
    const ok=db.pragma("quick_check",{simple:true});
    if(ok!=="ok" || val?.value!==process.argv[1])process.exitCode=1;
    db.close();
  ' "$2"
}
mark "$a" A_BEFORE_BACKUP
mark "$b" B_ONLY
verify "$a" A_BEFORE_BACKUP
verify "$b" B_ONLY
# Use the real off-mount export command in the running Node container.
docker exec -u node "$a" mkdir -m 700 /tmp/t04-export
docker exec -u node -e BACKUP_EXPORT_DIR=/tmp/t04-export "$a" \
  node dist/scripts/backup-db.js > "$tmp/export-result.json"
backup_name="$(node -e '
  const fs=require("fs"),path=require("path");
  const info=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(info.status!=="BACKUP_EXPORTED_LOCAL" || info.sameMountTestOverride || !info.path.startsWith("/tmp/t04-export/"))
    process.exit(1);
  process.stdout.write(path.basename(info.path));
' "$tmp/export-result.json")"
docker cp "$a:/tmp/t04-export/$backup_name" "$tmp/$backup_name"
docker cp "$a:/tmp/t04-export/$backup_name.manifest.json" "$tmp/$backup_name.manifest.json"
test -s "$tmp/$backup_name"
sha="$(sha256sum "$tmp/$backup_name" | awk '{print $1}')"
node -e '
  const fs=require("fs");
  const info=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(info.sha256!==process.argv[2])process.exit(1);
' "$tmp/export-result.json" "$sha"
node -e '
  const DB=require("better-sqlite3"), db=new DB(process.argv[1],{readonly:true,fileMustExist:true});
  if(db.pragma("quick_check",{simple:true})!=="ok" ||
     db.prepare("SELECT value FROM system_settings WHERE key=?").get("w3.docker.marker")?.value!=="A_BEFORE_BACKUP")
    process.exitCode=1;
  db.close();
' "$tmp/$backup_name"
mark "$a" A_AFTER_BACKUP
# Validate hash/manifest/schema/owner before copying into the independent volume.
mkdir -m 700 "$tmp/restore-checked"
W3_SANDBOX_ONLY=1 node scripts/verify-railway-offvolume-restore.cjs \
  "$tmp/$backup_name" "$tmp/restore-checked" > "$tmp/restore-result.json"
node -e '
  const fs=require("fs");
  const info=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(info.status!=="RESTORED_SANDBOX_ONLY" || info.sha256!==process.argv[2])process.exit(1);
' "$tmp/restore-result.json" "$sha"
docker run --rm --entrypoint /bin/sh -v "$vc:/app/data" -v "$tmp/restore-checked:/verified:ro" "$image" \
  -c 'set -eu; test ! -e /app/data/bot_report.sqlite; cp /verified/bot_report.sqlite /app/data/bot_report.sqlite; chown 1000:1000 /app/data/bot_report.sqlite; chmod 0600 /app/data/bot_report.sqlite'
run "$c" "$vc" "$key_a" "w3-restore.sandbox.up.railway.app"
unset key_a
probe "$c" /healthz 200
verify "$a" A_AFTER_BACKUP
verify "$b" B_ONLY
verify "$c" A_BEFORE_BACKUP
docker restart "$a" "$b" "$c" >/dev/null
probe "$a" /healthz 200
probe "$b" /healthz 200
probe "$c" /healthz 200
verify "$a" A_AFTER_BACKUP
verify "$b" B_ONLY
verify "$c" A_BEFORE_BACKUP
# The image must fail closed for read-only mounted SQLite; no production volume touched.
set +e
timeout 15 docker run --rm --name "$ro" --label t04.disposable=true \
  -v "$va:/app/data:ro" -e MCP_PLATFORM=railway -e RAILWAY_VOLUME_NAME="$va" \
  -e RAILWAY_VOLUME_MOUNT_PATH=/app/data -e DATABASE_PATH=/app/data/bot_report.sqlite \
  -e MCP_SETUP_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")" \
  -e RAILWAY_PUBLIC_DOMAIN=readonly.sandbox.up.railway.app "$image" >"$tmp/readonly-result.log" 2>&1
readonly_code=$?
set -e
if [[ "$readonly_code" = 0 || "$readonly_code" = 124 ]] || \
  ! grep -Eq 'Read-only file system|read-only file system|Failed to initialize persistent volume ownership|Persistent volume is not writable' "$tmp/readonly-result.log"; then
  echo 'FAIL: read-only mounted volume did not fail closed with a storage denial' >&2
  exit 1
fi
echo "DOCKER_ISOLATION_PASS backup_sha256=$sha mounts=3 restart=3 readonly=denied"
