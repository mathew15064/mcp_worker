#!/bin/sh
# Image-first standalone setup. Download this single script; no source checkout.
set -eu
umask 077
fail() { printf 'Quick setup: %s\n' "$*" >&2; exit 1; }
usage() { echo 'Usage: sh quick-setup.sh [--init|--start|--rebind|--down] (default: --init)'; }

mode="${1:---init}"
[ "$#" -le 1 ] || fail 'Unexpected argument.'
case "$mode" in --init|--start|--rebind|--down) ;; -h|--help) usage; exit 0 ;; *) usage; exit 2 ;; esac
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
# Prefer an explicit public origin for proxies/NAT; otherwise discover the host's
# outbound IPv4 source address (no network request is sent by `ip route get`).
find_public_origin() {
  if [ -n "${MCP_WORKER_PUBLIC_URL:-}" ]; then
    printf '%s\n' "$MCP_WORKER_PUBLIC_URL"
    return
  fi
  host_ip="${MCP_WORKER_PUBLIC_IP:-}"
  if [ -z "$host_ip" ] && command -v ip >/dev/null 2>&1; then
    host_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1);exit}}' || true)"
  fi
  if [ -z "$host_ip" ] && command -v hostname >/dev/null 2>&1; then
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if ! printf '%s\n' "$host_ip" | awk -F. 'NF != 4 {exit 1} {for(i=1;i<=4;i++) if($i !~ /^[0-9]+$/ || $i > 255 || $i < 0) exit 1}'; then
    fail 'Cannot determine host IPv4; set MCP_WORKER_PUBLIC_IP or MCP_WORKER_PUBLIC_URL.'
  fi
  case "$host_ip" in 0.*|127.*|169.254.*|255.*) fail 'Unusable host IP; set MCP_WORKER_PUBLIC_URL.' ;; esac
  printf 'http://%s:%s\n' "$host_ip" "$port"
}

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

# Optional owner-provided signed distribution is separate from the server image.
# This mount supplies bytes only; it never approves a signer or opens HTTP 503 routes.
signed_dist_dir="${MCP_WORKER_SIGNED_DIST_DIR:-}"
if [ -n "$signed_dist_dir" ]; then
  case "$signed_dist_dir" in /*) ;; *) fail 'Signed distribution directory must be an absolute path.' ;; esac
  case "$signed_dist_dir" in *','*|*[[:cntrl:]]*) fail 'Signed distribution directory contains unsafe mount characters.' ;; esac
  [ -d "$signed_dist_dir" ] && [ ! -L "$signed_dist_dir" ] || fail 'Signed distribution directory missing or symlinked.'
  [ "$(cd "$signed_dist_dir" && pwd -P)" = "$signed_dist_dir" ] || fail 'Signed distribution directory must use its canonical path.'
  command -v sha256sum >/dev/null 2>&1 && command -v cmp >/dev/null 2>&1 || fail 'Signed distribution checks require sha256sum and cmp.'
  case "$(stat -c %a "$signed_dist_dir")" in *[1357]) ;; *) fail 'Signed distribution directory must be traversable by the non-root server.' ;; esac
  for file in worker_mcp-linux-amd64 worker_mcp-linux-arm64 worker_mcp-linux-386 worker_mcp-linux-armv7 worker_mcp-darwin-amd64 worker_mcp-darwin-arm64 worker_mcp-windows-amd64.exe worker_mcp-windows-arm64.exe WORKER_RELEASE SHA256SUMS SHA256SUMS.sig; do
    [ -f "$signed_dist_dir/$file" ] && [ ! -L "$signed_dist_dir/$file" ] && [ -s "$signed_dist_dir/$file" ] || fail "Signed distribution file missing, empty or symlinked: $file"
    case "$(stat -c %a "$signed_dist_dir/$file")" in *[4567]) ;; *) fail "Signed distribution file is unreadable by the non-root server: $file" ;; esac
  done
  [ "$(find "$signed_dist_dir" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 11 ] || fail 'Signed distribution directory must contain exactly eleven release files.'
  (cd "$signed_dist_dir" && sha256sum worker_mcp-* WORKER_RELEASE | cmp -s - SHA256SUMS) || fail 'Signed distribution checksum inventory mismatch.'
fi

verify_signed_dist_mount() {
  actual="$(docker inspect "$name" --format '{{range .Mounts}}{{if eq .Destination "/app/dist/worker/bin"}}{{.Source}}{{end}}{{end}}')"
  [ "$actual" = "$signed_dist_dir" ] || fail 'Existing signed distribution mount differs; do not silently replace or remove it.'
}

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

saved_origin=""
if [ -f "$envfile" ]; then saved_origin="$(sed -n 's/^MCP_PUBLIC_BASE_URL=//p' "$envfile")"; fi
public_origin="${saved_origin:-$(find_public_origin)}"
case "$public_origin" in http://*|https://*) ;; *) fail 'Public URL must start with http:// or https://.' ;; esac
case "$public_origin" in *[[:space:]]*|*'#'*|*'?'*|*'@'*) fail 'Invalid public origin.' ;; esac

if [ "$mode" != --init ] && [ ! -e "$envfile" ]; then
  fail 'No installation found. Use --init for a fresh instance.'
fi

# Host bind is deliberately public; inside the container the server already
# listens on 0.0.0.0. Do not use 0.0.0.0 as the OAuth public URL.
start_server() {
  run_image="$1"
  bind_host="${2:-0.0.0.0}"
  set -- docker run -d --name "$name" --init --restart unless-stopped \
    --label mcp_worker.install=quick \
    --env-file "$envfile" -e NODE_ENV=production -e PORT=80 -e HOST=0.0.0.0 \
    -e TRUST_PROXY=false -e COOKIE_SECURE=false \
    -e "MCP_PUBLIC_BASE_URL=$public_origin" \
    --publish "$bind_host:$port:80" \
    --mount "type=volume,src=$volume,dst=/app/data"
  if [ -n "$signed_dist_dir" ]; then
    set -- "$@" --mount "type=bind,src=$signed_dist_dir,dst=/app/dist/worker/bin,readonly"
  fi
  "$@" "$run_image" >/dev/null
}

if [ "$mode" = --rebind ]; then
  container_exists || fail 'No installed Quick Setup container to rebind.'
  verify_ownership
  verify_signed_dist_mount
  attached_volume="$(docker inspect "$name" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}')"
  [ "$attached_volume" = "$volume" ] || fail 'Unexpected SQLite volume; refusing to recreate container.'
  published="$(docker port "$name" 80/tcp)"
  case "$published" in
    "0.0.0.0:$port")
      if [ "$(docker inspect "$name" --format '{{.State.Running}}')" != true ]; then
        docker start "$name" >/dev/null
      fi
      echo "Already listening on 0.0.0.0:$port." ;;
    "127.0.0.1:$port")
      original_image="$(docker inspect "$name" --format '{{.Image}}')"
      docker stop "$name" >/dev/null
      docker rm "$name" >/dev/null
      if ! start_server "$original_image"; then
        docker rm -f "$name" >/dev/null 2>&1 || true
        start_server "$original_image" 127.0.0.1 || fail 'Rebind and restore both failed; SQLite and secrets retained.'
        fail 'Rebind failed; original loopback binding restored.'
      fi
      echo "Updated host binding to 0.0.0.0:$port; SQLite and secrets retained." ;;
    *) fail "Unexpected published port: $published" ;;
  esac
elif container_exists; then
  # An installed instance may restart even after the public dev-main tag moves.
  # Never pull a replacement automatically over an existing SQLite database.
  verify_ownership
  verify_signed_dist_mount
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
      --env "MCP_WORKER_SETUP_PORT=$port" --env "MCP_PUBLIC_BASE_URL=$public_origin" \
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
  start_server "$image"
fi

tries=0
until docker exec "$name" node -e "fetch('http://127.0.0.1:80/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  tries=$((tries+1))
  [ "$tries" -lt 40 ] || fail "Readiness failed. Check docker logs $name; data retained."
  sleep 1
done
echo "Ready: listening on 0.0.0.0:$port; public URL $public_origin (Admin password in $envfile)"
