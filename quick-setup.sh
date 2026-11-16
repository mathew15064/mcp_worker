#!/bin/sh
# Image-first standalone setup. Download this single script; no source checkout.
set -eu
umask 077
fail() { printf 'Quick setup: %s\n' "$*" >&2; exit 1; }
usage() { echo 'Usage: sh quick-setup.sh [--init|--start|--down] (default: --init)'; }

mode="${1:---init}"
[ "$#" -le 1 ] || fail 'Unexpected argument.'
case "$mode" in --init|--start|--down) ;; -h|--help) usage; exit 0 ;; *) usage; exit 2 ;; esac
command -v docker >/dev/null 2>&1 || fail 'Docker Engine is required.'
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable.'
name="${MCP_WORKER_CONTAINER:-mcp_worker-server}"
volume="${MCP_WORKER_VOLUME:-mcp_worker_quick_app-data}"
image="${MCP_WORKER_IMAGE:-mathew15604/mcp-worker:dev-main}"
port="${MCP_WORKER_SETUP_PORT:-3333}"
case "$name" in ''|*[!a-zA-Z0-9_.-]* ) fail 'Invalid container name.' ;; esac
case "$volume" in ''|*[!a-zA-Z0-9_.-]* ) fail 'Invalid volume name.' ;; esac
case "$port" in ''|*[!0-9]*) fail 'Invalid port.' ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail 'Port out of range.'
envfile="$PWD/.env.setup"
[ ! -L "$envfile" ] && [ ! -L "$PWD" ] || fail 'Symlinked setup path refused.'

container_exists() { docker container inspect "$name" >/dev/null 2>&1; }
volume_exists() { docker volume inspect "$volume" >/dev/null 2>&1; }

verify_ownership() {
  owner="$(docker inspect "$name" --format '{{index .Config.Labels "mcp_worker.install"}}')"
  [ "$owner" = quick ] || fail "Container $name is not managed by Quick Setup."
}
if [ "$mode" = --down ]; then
  container_exists || fail "Container $name was not found."
  verify_ownership
  docker stop "$name" >/dev/null
  echo "Stopped $name; $volume and .env.setup retained."
  exit 0
fi

# Preserve the original secrets and data if any part of a previous install exists.
if [ ! -e "$envfile" ] && { volume_exists || container_exists; }; then
  fail 'Existing data/container but .env.setup is missing; restore credentials rather than regenerate.'
fi
if [ -e "$envfile" ] && ! volume_exists && ! container_exists; then
  fail 'Existing .env.setup without its data volume; restore the volume or use an empty directory.'
fi

if [ -e "$envfile" ]; then
  [ -f "$envfile" ] && [ ! -L "$envfile" ] || fail 'Invalid .env.setup (not a regular file).'
  [ "$(stat -c %a "$envfile")" = 600 ] || fail '.env.setup must have permission 0600.'
  saved_port="$(sed -n 's/^MCP_WORKER_PORT=//p' "$envfile")"
  [ -n "$saved_port" ] && [ "$saved_port" = "$port" ] || fail 'Saved port differs from requested port.'
fi

if [ "$mode" = --start ] && [ ! -e "$envfile" ]; then
  fail 'No installation found. Use --init for a fresh instance.'
fi

if container_exists; then
  # An installed instance may restart even after the public dev-main tag moves.
  # Never pull a replacement automatically over an existing SQLite database.
  verify_ownership
else
  case "${MCP_WORKER_PULL:-always}" in
    always) docker pull "$image" >/dev/null ;;
    never) docker image inspect "$image" >/dev/null 2>&1 || fail "Local image $image is unavailable." ;;
    *) fail 'MCP_WORKER_PULL must be always or never.' ;;
  esac
fi

if container_exists; then
  if [ "$(docker inspect "$name" --format '{{.State.Running}}')" != true ]; then
    docker start "$name" >/dev/null
  fi
else
  if [ ! -e "$envfile" ]; then
    # Avoid requiring Node/npm/openssl on the host. Container writes the secret file.
    docker run --rm --network none --user "$(id -u):$(id -g)" \
      --env "MCP_WORKER_SETUP_PORT=$port" \
      --mount "type=bind,src=$PWD,dst=/setup" --entrypoint node "$image" \
      dist/scripts/quick-setup.cjs /setup/.env.setup
  fi
  [ -f "$envfile" ] && [ ! -L "$envfile" ] || fail 'Private .env.setup missing.'
  [ "$(stat -c %a "$envfile")" = 600 ] || fail '.env.setup must have permission 0600.'
  # Do not start if another container holds this SQLite volume.
  if volume_exists; then
    users="$(docker ps -q --filter "volume=$volume")"
    [ -z "$users" ] || fail "Volume $volume is attached to a running container; refusing a second SQLite writer."
  else
    docker volume create "$volume" >/dev/null
  fi
  if [ "$mode" = --init ]; then
    docker run --rm --network none --env-file "$envfile" \
      --mount "type=volume,src=$volume,dst=/app/data" --entrypoint node "$image" \
      scripts/init-bundled-db.js --init-fresh
  fi
  docker run -d --name "$name" --init --restart unless-stopped \
    --label mcp_worker.install=quick \
    --env-file "$envfile" -e NODE_ENV=production -e PORT=80 -e HOST=0.0.0.0 \
    -e TRUST_PROXY=false -e COOKIE_SECURE=false \
    -e "MCP_PUBLIC_BASE_URL=http://127.0.0.1:$port" \
    --publish "127.0.0.1:$port:80" \
    --mount "type=volume,src=$volume,dst=/app/data" "$image" >/dev/null
fi

tries=0
until docker exec "$name" node -e "fetch('http://127.0.0.1:80/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  tries=$((tries+1))
  [ "$tries" -lt 40 ] || fail "Readiness failed. Check docker logs $name; data retained."
  sleep 1
done
echo "Ready: http://127.0.0.1:$port/admin (username admin; password in $envfile)"
