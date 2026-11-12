#!/bin/sh
set -eu
# Railway volume is root-owned. Use root only to fix directory ownership.
if [ "$MCP_PLATFORM" != railway ]; then
  echo '[RAILWAY_BOOT] Incorrect platform.' >&2; exit 1
fi
if [ "$RAILWAY_VOLUME_MOUNT_PATH" != /app/data ] || [ -z "$RAILWAY_VOLUME_NAME" ]; then
  echo '[RAILWAY_BOOT] A persistent /app/data Railway volume is mandatory.' >&2; exit 1
fi
if [ "$DATABASE_PATH" != /app/data/bot_report.sqlite ]; then
  echo '[RAILWAY_BOOT] Database must be stored on /app/data volume.' >&2; exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo '[RAILWAY_BOOT] Volume initializer must start as root.' >&2; exit 1
fi
if [ ! -d /app/data ] || [ -L /app/data ]; then
  echo '[RAILWAY_BOOT] Missing volume directory or unexpected symlink.' >&2; exit 1
fi
chown node:node /app/data
chmod 0700 /app/data
exec su-exec node "$@"
