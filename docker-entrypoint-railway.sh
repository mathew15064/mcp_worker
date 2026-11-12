#!/bin/sh
set -eu

# Root is needed only for Railway's root-owned volume mount initialization.
if [ "${MCP_PLATFORM:-}" != railway ]; then
  echo '[RAILWAY_BOOT] Incorrect platform.' >&2; exit 1
fi
if [ "${RAILWAY_VOLUME_MOUNT_PATH:-}" != /app/data ] || [ -z "${RAILWAY_VOLUME_NAME:-}" ]; then
  echo '[RAILWAY_BOOT] A persistent /app/data Railway volume is mandatory.' >&2; exit 1
fi
if [ "${DATABASE_PATH:-}" != /app/data/bot_report.sqlite ]; then
  echo '[RAILWAY_BOOT] Database must be stored on /app/data volume.' >&2; exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo '[RAILWAY_BOOT] Volume initializer must start as root.' >&2; exit 1
fi
if [ ! -d /app/data ] || [ -L /app/data ]; then
  echo '[RAILWAY_BOOT] Missing volume directory or unexpected symlink.' >&2; exit 1
fi

# A Railway volume identity in env is not proof of a real mount. The mount must
# be visible at this exact path in the Linux container's mount namespace.
if [ ! -r /proc/self/mountinfo ] ||
  ! awk '$5 == "/app/data" { found = 1 } END { exit !found }' /proc/self/mountinfo; then
  echo '[RAILWAY_BOOT] /app/data is not a mounted volume; refusing ephemeral SQLite.' >&2
  exit 1
fi

# SQLite WAL and SHM must not escape the mounted directory via file symlinks.
for file in /app/data/bot_report.sqlite /app/data/bot_report.sqlite-wal /app/data/bot_report.sqlite-shm; do
  if [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then
    echo '[RAILWAY_BOOT] Unsafe SQLite file type or symlink.' >&2; exit 1
  fi
done

if ! chown node:node /app/data || ! chmod 0700 /app/data; then
  echo '[RAILWAY_BOOT] Failed to initialize persistent volume ownership.' >&2
  exit 1
fi
# Probe using the actual unprivileged runtime identity, not root's access().
if ! su-exec node sh -c '
  umask 077
  probe="$(mktemp /app/data/.railway-write-probe.XXXXXXXX)" || exit 1
  rm -f "$probe" || exit 1
'; then
  echo '[RAILWAY_BOOT] Persistent volume is not writable by node.' >&2
  exit 1
fi
for file in /app/data/bot_report.sqlite /app/data/bot_report.sqlite-wal /app/data/bot_report.sqlite-shm; do
  if [ -e "$file" ] && ! su-exec node test -w "$file"; then
    echo '[RAILWAY_BOOT] Existing SQLite file is not writable by node.' >&2
    exit 1
  fi
done

exec su-exec node "$@"
