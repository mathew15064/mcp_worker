#!/bin/sh
# Standalone local installation. No host package changes or destructive DB actions.
set -eu
umask 077
cd "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() { echo "Usage: ./setup.sh [--init|--down] (default: start without schema initialization)"; }
mode=start
case "${1:-}" in
  '') ;;
  --init) mode=init ;;
  --down) mode=down ;;
  -h|--help) usage; exit 0 ;;
  *) usage; exit 2 ;;
esac
[ "$#" -le 1 ] || fail "Unexpected arguments."
for cmd in docker openssl flock git; do command -v "$cmd" >/dev/null 2>&1 || fail "Missing prerequisite: $cmd"; done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 required."
docker info >/dev/null 2>&1 || fail "Docker daemon unavailable."
envfile="${BOT_REPORT_SETUP_ENV:-.env.setup}"
case "$envfile" in .env.setup|.env.setup-*) ;; *) fail "Use a local .env.setup or .env.setup-* file." ;; esac
case "$envfile" in */*) fail "Invalid env file path." ;; esac
[ ! -L "$envfile" ] && [ ! -L "$envfile.lock" ] || fail "Symlink state refused."
exec 9>"$envfile.lock"
flock -n 9 || fail "Another setup is running."
# Compose shell variables take precedence over env-file; refuse implicit secret overrides.
unset ADMIN_PASSWORD SESSION_SECRET APP_ENCRYPTION_KEY MYSQL_PASSWORD MYSQL_ROOT_PASSWORD COMPOSE_PROJECT_NAME
project="${BOT_REPORT_SETUP_PROJECT:-bot-report}"
port="${BOT_REPORT_SETUP_PORT:-3333}"
case "$project" in ''|*[!a-z0-9_-]*|[-_]*) fail "Invalid Compose project name." ;; esac
case "$port" in ''|*[!0-9]*) fail "Invalid port." ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "Invalid port."
unset BOT_REPORT_PORT
if [ ! -e "$envfile" ]; then
  [ "$mode" != down ] || fail "No installation configuration."
  # Lost credentials must never be regenerated over existing volumes.
  for suffix in app-data mysql-data; do
    if docker volume inspect "${project}_$suffix" >/dev/null 2>&1; then fail "Existing volume found; restore original installer env."; fi
  done
  tmp=$(mktemp "./$envfile.XXXXXX")
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  {
    printf 'COMPOSE_PROJECT_NAME=%s\nBOT_REPORT_PORT=%s\n' "$project" "$port"
    printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'APP_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)"
    printf 'MYSQL_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'MYSQL_ROOT_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$envfile"
  trap - EXIT HUP INT TERM
fi
[ -f "$envfile" ] || fail "Installer env is not a regular file."
chmod 600 "$envfile"
# Read only non-secret values; never source the file as shell code.
project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$envfile")
port=$(sed -n 's/^BOT_REPORT_PORT=//p' "$envfile")
case "$project" in ''|*[!a-z0-9_-]*|[-_]*) fail "Invalid saved project." ;; esac
case "$port" in ''|*[!0-9]*) fail "Invalid saved port." ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "Invalid saved port."
export BOT_REPORT_GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
export BOT_REPORT_BUILD_TIME="$(git show -s --format=%cI HEAD 2>/dev/null || echo unknown)"
compose() { docker compose --env-file "$envfile" -p "$project" -f docker-compose.yml "$@"; }
compose config -q || fail "Invalid installer configuration."
if [ "$mode" = down ]; then
  compose down
  echo "Stopped. Data volumes and $envfile retained."
  exit 0
fi
# Preserve running containers on errors; no automatic down -v or reset.
compose up -d --build --wait --wait-timeout 240 || fail "Startup failed; data retained. Inspect compose ps/logs."
if [ "$mode" = init ]; then
  compose exec -T bot-report node scripts/init-bundled-db.js --init-fresh || fail "Initialization refused or failed; data retained. Use Admin database recovery."
  # Reload encrypted bootstrap only if the current app is not already ready.
  if ! compose exec -T bot-report node -e "fetch('http://127.0.0.1/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    compose restart bot-report
  fi
  i=0
  until compose exec -T bot-report node -e "fetch('http://127.0.0.1/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -lt 60 ] || fail "Readiness timeout; data retained."
    sleep 2
  done
fi
printf 'Admin: http://127.0.0.1:%s/admin (username admin; password in %s)\n' "$port" "$envfile"
