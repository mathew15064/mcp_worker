#!/usr/bin/env bash
# T4 only: encrypted off-volume export -> independent Docker object-store volume
# -> retrieved volume -> NEW empty restore volume. All are disposable on PC.
set -euo pipefail
if [[ "${T04_LOCAL_TEST_ONLY:-}" != 1 || -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ||
      -n "${DATABASE_PATH:-}" || -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ||
      -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]]; then
  echo 'T4_DOCKER_REFUSED: disposable local PC-only test, no configured database/key' >&2
  exit 2
fi
image="${1:-t04-railway-sandbox:local}"
command -v docker >/dev/null
docker info >/dev/null
# The historical disposable T4 image remains accepted on T4's own PC.
# The final integration accepts ONLY its exact committed, locally built image:
# pinned worktree path + branch + clean tree + source label + SHA-derived tag.
if [[ "$image" != 't04-railway-sandbox:local' ]]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  if [[ "$root" != '/root/mcp_worker_railway_oneclick_final_integration_20261113' ]] ||
     [[ "$(git -C "$root" branch --show-current)" != 'work/railway-oneclick-final-integration-20261113' ]] ||
     [[ -n "$(git -C "$root" status --porcelain)" ]]; then
    echo 'T4_DOCKER_REFUSED: final image requires the clean authorized PC worktree' >&2
    exit 2
  fi
  source_sha="$(git -C "$root" rev-parse HEAD)"
  [[ "$image" == "mcp-worker-local:${source_sha:0:12}" ]] || {
    echo 'T4_DOCKER_REFUSED: final image tag does not match current source SHA' >&2
    exit 2
  }
  image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")" || exit 2
  [[ "$image_revision" == "$source_sha" ]] || {
    echo 'T4_DOCKER_REFUSED: final Docker image was not built from current source SHA' >&2
    exit 2
  }
fi
docker image inspect "$image" >/dev/null
prefix="t04-offsite-$$-$RANDOM"
source_container="$prefix-source"
restored_container="$prefix-restored"
vol_source="$prefix-source-db"
vol_export="$prefix-export"
vol_store="$prefix-independent-store"
vol_retrieval="$prefix-retrieval"
vol_restore="$prefix-new-restore"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/t4-offsite-volume.XXXXXXXX")"
chmod 700 "$tmp"
cleanup() {
  docker rm -f "$source_container" "$restored_container" >/dev/null 2>&1 || true
  for v in "$vol_source" "$vol_export" "$vol_store" "$vol_retrieval" "$vol_restore"; do
    docker volume rm "$v" >/dev/null 2>&1 || true
  done
  rm -rf -- "$tmp"
}
trap cleanup EXIT
for v in "$vol_source" "$vol_export" "$vol_store" "$vol_retrieval" "$vol_restore"; do
  docker volume create --label t04.offsite.disposable=true "$v" >/dev/null
done
mkdir -m 700 "$tmp/keys"
openssl rand -out "$tmp/keys/backup.key" 32
chmod 600 "$tmp/keys/backup.key"
setup_secret="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
# Container volumes isolate all three persistent locations; tmpfs holds plaintext.
docker run -d --name "$source_container" --label t04.offsite.disposable=true \
  --network bridge -p 127.0.0.1::80 \
  -v "$vol_source:/app/data" -v "$vol_export:/t4/export" \
  -v "$tmp/keys:/run/t4-keys:ro" \
  --tmpfs /t4/stage:rw,size=128m,mode=0700,uid=1000,gid=1000 \
  -e MCP_PLATFORM=railway -e RAILWAY_VOLUME_NAME="$vol_source" \
  -e RAILWAY_VOLUME_MOUNT_PATH=/app/data -e DATABASE_PATH=/app/data/bot_report.sqlite \
  -e MCP_SETUP_SECRET="$setup_secret" -e RAILWAY_PUBLIC_DOMAIN=offsite-source.sandbox.up.railway.app \
  "$image" >/dev/null
for _ in {1..40}; do
  if docker exec "$source_container" node -e \
    'const D=require("better-sqlite3");const d=new D("/app/data/bot_report.sqlite",{readonly:true,fileMustExist:true});const v=d.pragma("quick_check",{simple:true});d.close();process.exit(v==="ok"?0:1)' \
    >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$source_container" node -e '
  const DB=require("better-sqlite3"), d=new DB("/app/data/bot_report.sqlite");
  d.prepare("INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,?,?)")
    .run("bootstrap.admin_password_hash",require("bcryptjs").hashSync("isolated-fixture-only",4),new Date().toISOString());
  d.prepare("INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,?,?)")
    .run("t4.offsite.marker","BEFORE",new Date().toISOString());d.close();
'
docker exec -u 0 "$source_container" chown 1000:1000 /t4/export
docker exec -u 0 -e BACKUP_EXPORT_DIR=/t4/export \
  -e BACKUP_STAGING_DIR=/t4/stage \
  -e BACKUP_ENCRYPTION_KEY_FILE=/run/t4-keys/backup.key \
  "$source_container" node dist/scripts/backup-db.js > "$tmp/export.json"
backup_name="$(node -e '
  const i=require(process.argv[1]);
  if(i.status!=="BACKUP_EXPORTED_ENCRYPTED_LOCAL" || i.sameMountTestOverride ||
      i.encrypted!==true || !i.path.startsWith("/t4/export/"))process.exit(1);
  process.stdout.write(require("node:path").basename(i.path));
' "$tmp/export.json")"
[[ "$backup_name" == *.sqlite.enc ]]
docker exec "$source_container" node -e '
  const d=new (require("better-sqlite3"))("/app/data/bot_report.sqlite");
  d.prepare("UPDATE system_settings SET value=? WHERE key=?").run("AFTER","t4.offsite.marker");d.close();
'
# Deposit: transfer ONLY ciphertext + HMAC-authenticated manifest to a separate named volume.
docker run --rm --network none --entrypoint sh \
  -v "$vol_export:/source:ro" -v "$vol_store:/target" "$image" -c \
  'set -eu; umask 077; test "$(find /source -maxdepth 1 -type f | wc -l)" -eq 2; cp /source/*.sqlite.enc /target/; cp /source/*.manifest.json /target/; test "$(find /target -mindepth 1 -maxdepth 1 | wc -l)" -eq 2'
# Retrieve into yet another empty Docker named volume. No key ever reaches storage.
docker run --rm --network none --entrypoint sh \
  -v "$vol_store:/source:ro" -v "$vol_retrieval:/target" "$image" -c \
  'set -eu; umask 077; cp /source/*.sqlite.enc /target/; cp /source/*.manifest.json /target/; test "$(find /target -mindepth 1 -maxdepth 1 | wc -l)" -eq 2'
# Restore only through the authenticated sandbox preflight, into NEW empty volume.
docker run --rm --network none --entrypoint node \
  -e W3_SANDBOX_ONLY=1 -e W3_BACKUP_KEY_FILE=/run/t4-keys/backup.key \
  -v "$vol_retrieval:/tmp/offsite:ro" -v "$vol_restore:/tmp/newempty" \
  -v "$tmp/keys:/run/t4-keys:ro" \
  -v "$PWD/scripts/verify-railway-offvolume-restore.cjs:/app/t4-restore.cjs:ro" \
  "$image" /app/t4-restore.cjs "/tmp/offsite/$backup_name" /tmp/newempty > "$tmp/restore.json"
node -e '
  const i=require(process.argv[1]);
  if(i.status!=="RESTORED_SANDBOX_ONLY"||!i.encrypted||!i.ownerPresent)process.exit(1);
' "$tmp/restore.json"
docker run --rm --network none --entrypoint sh \
  -v "$vol_store:/store:ro" "$image" -c \
  'set -eu; test "$(find /store -mindepth 1 -maxdepth 1 | wc -l)" -eq 2; ! find /store -iname "*key*" | grep -q .'
# Validate recovered data, source remains modified, store remains ciphertext-only.
docker run --rm --network none --entrypoint node -v "$vol_restore:/app/data" "$image" -e '
  const d=new (require("better-sqlite3"))("/app/data/bot_report.sqlite",{readonly:true,fileMustExist:true});
  if(d.pragma("integrity_check",{simple:true})!=="ok" ||
    d.prepare("SELECT value FROM system_settings WHERE key=?").get("t4.offsite.marker")?.value!=="BEFORE")
    process.exitCode=1;d.close();
'
docker exec "$source_container" node -e '
  const d=new (require("better-sqlite3"))("/app/data/bot_report.sqlite",{readonly:true,fileMustExist:true});
  if(d.prepare("SELECT value FROM system_settings WHERE key=?").get("t4.offsite.marker")?.value!=="AFTER")
    process.exitCode=1;d.close();
'
# The sandbox restore runs as root in a helper container; transfer ownership
# of ONLY this new disposable volume before launching the non-root app.
docker run --rm --network none --entrypoint sh -v "$vol_restore:/app/data" "$image" \
  -c 'set -eu; chown -R 1000:1000 /app/data; chmod 0600 /app/data/bot_report.sqlite'
# Let restored application open the distinct volume using the same disposable secret.
docker run -d --name "$restored_container" --label t04.offsite.disposable=true \
  -p 127.0.0.1::80 -v "$vol_restore:/app/data" \
  -e MCP_PLATFORM=railway -e RAILWAY_VOLUME_NAME="$vol_restore" \
  -e RAILWAY_VOLUME_MOUNT_PATH=/app/data -e DATABASE_PATH=/app/data/bot_report.sqlite \
  -e MCP_SETUP_SECRET="$setup_secret" \
  -e RAILWAY_PUBLIC_DOMAIN=offsite-restored.sandbox.up.railway.app "$image" >/dev/null
for _ in {1..30}; do
  if docker exec "$restored_container" node -e \
    "fetch('http://127.0.0.1:80/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! docker exec "$restored_container" node -e \
  "fetch('http://127.0.0.1:80/healthz').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"; then
  docker inspect "$restored_container" --format 'T4_RESTORED_STATE={{.State.Status}} Exit={{.State.ExitCode}}' >&2
  docker logs "$restored_container" >&2
  exit 1
fi
echo "T04_DOCKER_ENCRYPTED_OFFSITE_SIM_PASS volumes=5 manifest=HMAC-SHA256 ciphertext=AES-256-GCM readonly_store=yes restored_new_volume=yes REMOTE_BACKUP_NOT_TESTED"
