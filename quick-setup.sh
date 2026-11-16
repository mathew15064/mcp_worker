#!/bin/sh
# Image-first standalone setup. Download this single script; no source checkout.
set -eu
umask 077
fail() { printf 'Quick setup: %s\n' "$*" >&2; exit 1; }
usage() { echo 'Usage: sh quick-setup.sh [--init|--start|--rebind|--https|--down] (default: --init)'; }

mode="${1:---init}"
[ "$#" -le 1 ] || fail 'Unexpected argument.'
case "$mode" in --init|--start|--rebind|--https|--down) ;; -h|--help) usage; exit 0 ;; *) usage; exit 2 ;; esac
command -v docker >/dev/null 2>&1 || fail 'Docker Engine is required.'
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable.'
name="${MCP_WORKER_CONTAINER:-mcp_worker-server}"
volume="${MCP_WORKER_VOLUME:-mcp_worker_quick_app-data}"
image="${MCP_WORKER_IMAGE:-mathew15604/mcp-worker:dev-main}"
port="${MCP_WORKER_SETUP_PORT:-3333}"
tls_mode="${MCP_WORKER_TLS_MODE:-auto}"
case "$tls_mode" in auto|external) ;; *) fail 'MCP_WORKER_TLS_MODE must be auto or external.' ;; esac
case "$name" in ''|*[!a-zA-Z0-9_.-]* ) fail 'Invalid container name.' ;; esac
case "$volume" in ''|*[!a-zA-Z0-9_.-]* ) fail 'Invalid volume name.' ;; esac
case "$port" in ''|*[!0-9]*) fail 'Invalid port.' ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail 'Port out of range.'
# Prefer an explicit public origin for proxies/NAT; otherwise discover the host's
# outbound IPv4 source address (no network request is sent by `ip route get`).
find_public_origin() {
  if [ -n "${MCP_WORKER_PUBLIC_URL:-}" ]; then
    case "$MCP_WORKER_PUBLIC_URL" in https://*) ;; *) fail 'Explicit public URL must use HTTPS.' ;; esac
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
  case "$host_ip" in
    0.*|10.*|127.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|255.*)
      fail 'Private/unusable host IP; supply MCP_WORKER_PUBLIC_IP or an HTTPS public URL.' ;;
  esac
  https_port="${MCP_WORKER_HTTPS_PORT:-}"
  if [ -z "$https_port" ]; then
    https_port=443
    # On shared VPS hosts keep the existing TLS/hostname listeners on 443.
    if command -v ss >/dev/null 2>&1 && ss -ltn | grep -Eq ':443[[:space:]]'; then
      https_port=3443
    fi
  fi
  case "$https_port" in ''|*[!0-9]*) fail 'MCP_WORKER_HTTPS_PORT must be numeric.' ;; esac
  [ "$https_port" -ge 1 ] && [ "$https_port" -le 65535 ] || fail 'HTTPS port out of range.'
  if [ "$https_port" -eq 443 ]; then
    printf 'https://%s\n' "$host_ip"
  else
    printf 'https://%s:%s\n' "$host_ip" "$https_port"
  fi
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

if [ "$mode" != --init ] && [ ! -e "$envfile" ]; then
  fail 'No installation found. Use --init for a fresh instance.'
fi

saved_origin=""
if [ -f "$envfile" ]; then saved_origin="$(sed -n 's/^MCP_PUBLIC_BASE_URL=//p' "$envfile")"; fi
if [ "$mode" = --https ]; then
  [ -n "${MCP_WORKER_PUBLIC_URL:-}" ] || fail '--https requires MCP_WORKER_PUBLIC_URL=https://IP:PORT or https://hostname.'
  public_origin="$MCP_WORKER_PUBLIC_URL"
else
  public_origin="${saved_origin:-$(find_public_origin)}"
fi
case "$public_origin" in
  https://*) ;;
  http://*) [ -n "$saved_origin" ] || fail 'New public deployments require HTTPS.' ;;
  *) fail 'Public URL must start with HTTPS.' ;;
esac
origin_authority="${public_origin#*://}"
case "$origin_authority" in
  ''|*/*|*'@'*|*'?'*|*'#'*|*[!a-zA-Z0-9.:_-]*)
    fail 'Public URL must be a bare IP/hostname HTTPS origin and optional port.' ;;
esac

# Keep the public installer one-file: fetch only the owner-reviewed TLS helper.
# SHA-256 pins the executed bytes even if the remote branch subsequently moves.
provision_host_tls() {
  [ "$tls_mode" = auto ] || return 0
  command -v curl >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1 ||
    fail 'Automatic HTTPS requires curl and sha256sum.'
  helper="$(mktemp "${TMPDIR:-/tmp}/mcpw-host-tls.XXXXXXXX")" || fail 'Cannot create HTTPS helper staging file.'
  if ! curl -fsS --proto '=https' --max-redirs 0 --max-time 30 \
    'https://raw.githubusercontent.com/mathew15064/mcp_worker/main/scripts/provision-host-https.sh' -o "$helper"; then
    rm -f "$helper"
    fail 'Cannot download trusted TLS provisioning helper.'
  fi
  if [ "$(sha256sum "$helper" | awk '{print $1}')" != '56671b77fa177a24fece8afb53a2375c187a7b9c83a78500915abca2f4bf814b' ]; then
    rm -f "$helper"
    fail 'TLS helper SHA-256 mismatch; refusing remote code execution.'
  fi
  if ! sh "$helper" "$public_origin" "$port"; then
    rm -f "$helper"
    fail 'HTTPS provisioning failed. Check DNS/port 80 or choose MCP_WORKER_TLS_MODE=external.'
  fi
  rm -f "$helper"
}

# HTTPS is terminated by a trusted local proxy; keep its backend loopback-only.
# Legacy HTTP servers retain their binding until a deliberate HTTPS migration.
start_server() {
  run_image="$1"
  case "$public_origin" in
    https://*) bind_host="127.0.0.1"; trust_proxy=1; cookie_secure=true ;;
    *) bind_host="${2:-0.0.0.0}"; trust_proxy=false; cookie_secure=false ;;
  esac
  set -- docker run -d --name "$name" --init --restart unless-stopped \
    --label mcp_worker.install=quick \
    --env-file "$envfile" -e NODE_ENV=production -e PORT=80 -e HOST=0.0.0.0 \
    -e "TRUST_PROXY=$trust_proxy" -e "COOKIE_SECURE=$cookie_secure" \
    -e "MCP_PUBLIC_BASE_URL=$public_origin" \
    --publish "$bind_host:$port:80" \
    --mount "type=volume,src=$volume,dst=/app/data"
  if [ -n "$signed_dist_dir" ]; then
    set -- "$@" --mount "type=bind,src=$signed_dist_dir,dst=/app/dist/worker/bin,readonly"
  fi
  "$@" "$run_image" >/dev/null
}

# Deliberate HTTPS cutover: validate the real public certificate and proxy
# before changing the only Quick Setup container or its persistent settings.
if [ "$mode" = --https ]; then
  [ -n "$saved_origin" ] || fail 'Existing Quick Setup origin is missing.'
  container_exists || fail 'Existing Quick Setup container is missing.'
  volume_exists || fail 'Existing SQLite volume is missing.'
  verify_ownership
  verify_signed_dist_mount
  [ "$(docker inspect "$name" --format '{{.State.Running}}')" = true ] || fail 'Existing container must be running.'
  [ "$(docker inspect "$name" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}')" = "$volume" ] || fail 'Unexpected SQLite mount.'
  command -v curl >/dev/null 2>&1 || fail 'curl is required to verify external HTTPS.'
  if [ "$tls_mode" = auto ] && ! curl -fsS --proto '=https' --max-redirs 0 --max-time 8 "$public_origin/healthz" 2>/dev/null |
    grep -q '"service":"mcp_worker"'; then
    provision_host_tls
  fi
  curl -fsS --proto '=https' --max-redirs 0 --max-time 15 "$public_origin/healthz" |
    grep -q '"service":"mcp_worker"' || fail 'Trusted HTTPS healthcheck failed; refusing cutover.'
  current_bind="$(docker port "$name" 80/tcp)"
  case "$current_bind" in "0.0.0.0:$port"|"127.0.0.1:$port") ;; *) fail 'Unexpected host port binding.' ;; esac
  if [ "$saved_origin" = "$public_origin" ]; then
    [ "$current_bind" = "127.0.0.1:$port" ] || fail 'HTTPS origin configured but backend is not loopback-only.'
    echo "HTTPS origin already configured: $public_origin"
    exit 0
  fi

  original_image="$(docker inspect "$name" --format '{{.Image}}')"
  docker image inspect "$original_image" >/dev/null 2>&1 || fail 'Original image unavailable for recovery.'
  old_public_origin="$saved_origin"
  old_db_origin="$(docker exec "$name" node -e '
    const D=require("better-sqlite3");
    const d=new D("data/mcp_worker.sqlite",{readonly:true});
    const row=d.prepare("SELECT value FROM system_settings WHERE key=?").get("mcp.public_base_url");
    if (!row || typeof row.value !== "string") process.exit(1);
    console.log(row.value);
    d.close();
  ')" || fail 'Cannot read existing SQLite origin.'

  # Online SQLite backup, stored alongside the live database in its volume.
  docker exec "$name" node -e '
    const D=require("better-sqlite3"),fs=require("node:fs");
    const d=new D("data/mcp_worker.sqlite",{readonly:true});
    const target="data/.mcp-worker-before-https-"+Date.now()+".sqlite";
    if(fs.existsSync(target)||d.pragma("integrity_check",{simple:true})!=="ok")process.exit(2);
    d.backup(target).then(()=>{
      const check=new D(target,{readonly:true});
      if(check.pragma("integrity_check",{simple:true})!=="ok")process.exit(4);
      check.close();d.close();console.log("SQLite backup verified");
    }).catch(()=>process.exit(3));
  ' || fail 'SQLite backup failed; refusing HTTPS cutover.'

  set_db_public_origin() {
    docker run --rm --network none --env "MCP_NEXT_PUBLIC_URL=$1"       --mount "type=volume,src=$volume,dst=/app/data" --entrypoint node "$original_image" -e '
        const D=require("better-sqlite3"), db=new D("data/mcp_worker.sqlite");
        const r=db.prepare("UPDATE system_settings SET value=?, updated_at=? WHERE key=?")
          .run(process.env.MCP_NEXT_PUBLIC_URL,new Date().toISOString(),"mcp.public_base_url");
        db.close();
        if(r.changes!==1)process.exit(3);
      '
  }
  old_bind="$(printf '%s' "$current_bind" | sed "s/:$port$//")"
  original_env_backup="$(mktemp "$PWD/.env.setup.pre-https.XXXXXXXX")" || fail 'Cannot create env recovery copy.'
  cp "$envfile" "$original_env_backup"
  chmod 0600 "$original_env_backup"
  new_env_file="$(mktemp "$PWD/.env.setup.new.XXXXXXXX")" || fail 'Cannot prepare HTTPS env.'
  sed "s|^MCP_PUBLIC_BASE_URL=.*|MCP_PUBLIC_BASE_URL=$public_origin|" "$envfile" > "$new_env_file"
  chmod 0600 "$new_env_file"
  rollback_https() {
    status=$?
    trap - EXIT
    if [ "$status" -ne 0 ]; then
      echo 'HTTPS cutover failed; restoring original container and origin.' >&2
      docker rm -f "$name" >/dev/null 2>&1 || :
      cp "$original_env_backup" "$envfile" || :
      public_origin="$old_public_origin"
      set_db_public_origin "$old_db_origin" >/dev/null 2>&1 || echo 'WARNING: SQLite URL recovery failed; restore the online backup.' >&2
      start_server "$original_image" "$old_bind" || echo 'WARNING: container recovery failed; SQLite volume retained.' >&2
    fi
    rm -f "$new_env_file" "$original_env_backup"
    exit "$status"
  }
  trap rollback_https EXIT
  trap 'exit 1' INT HUP TERM
  docker stop "$name" >/dev/null
  docker rm "$name" >/dev/null
  set_db_public_origin "$public_origin" >/dev/null
  mv "$new_env_file" "$envfile"
  start_server "$original_image"
  tries=0
  until docker exec "$name" node -e "fetch('http://127.0.0.1:80/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
    tries=$((tries+1))
    [ "$tries" -lt 40 ] || fail 'HTTPS container readiness failed.'
    sleep 1
  done
  curl -fsS --proto '=https' --max-redirs 0 --max-time 15 "$public_origin/readyz" >/dev/null ||
    fail 'External HTTPS readiness failed after cutover.'
  trap - EXIT INT HUP TERM
  rm -f "$original_env_backup" "$new_env_file"
  echo "HTTPS cutover complete: $public_origin (SQLite and private setup credentials preserved)."
  exit 0
fi

if [ "$mode" = --rebind ]; then
  case "$public_origin" in https://*) fail '--rebind cannot publicly expose an HTTPS-proxied backend.' ;; esac
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
  if [ "$mode" = --init ]; then
    [ ! -e "$envfile" ] && ! volume_exists ||
      fail 'Existing setup or SQLite volume detected; --init may only create fresh instances.'
    provision_host_tls
  fi
  if [ ! -e "$envfile" ]; then
    # Avoid requiring Node/npm/openssl on the host. Container writes the secret file.
    docker run --rm --network none --user "$(id -u):$(id -g)" \
      --env "MCP_WORKER_SETUP_PORT=$port" --env "MCP_PUBLIC_BASE_URL=$public_origin" \
      --mount "type=bind,src=$PWD,dst=/setup" --entrypoint node "$image" \
      dist/scripts/quick-setup.cjs /setup/.env.setup
  fi
  [ -f "$envfile" ] && [ ! -L "$envfile" ] || fail 'Private .env.setup missing.'
  [ "$(stat -c %a "$envfile")" = 600 ] || fail '.env.setup must have permission 0600.'
  # --init must never recreate an orphaned existing database.
  if [ "$mode" = --init ] && volume_exists; then
    fail 'Existing SQLite volume detected; --init refused. Restore the container or use --start.'
  fi
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
if [ "$mode" = --init ] && [ "$tls_mode" = auto ]; then
  curl -fsS --proto '=https' --max-redirs 0 --max-time 15 "$public_origin/readyz" >/dev/null ||
    fail 'Backend is ready, but public HTTPS is unreachable or untrusted.'
fi
case "$public_origin" in
  https://*)
    echo "Ready: backend on 127.0.0.1:$port; HTTPS origin $public_origin (Admin password in $envfile)"
    echo "HTTPS origin: $public_origin (verify certificate and renewal before enrolling Workers)." ;;
  *)
    echo "Ready: legacy HTTP on 0.0.0.0:$port; public URL $public_origin (Admin password in $envfile)" ;;
esac
