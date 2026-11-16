#!/bin/sh
set -e

# SQLite must reside on durable local storage; no implicit reset on startup.
umask 077
DATA_DIR="${BOT_REPORT_DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"
if [ ! -r "$DATA_DIR" ] || [ ! -w "$DATA_DIR" ]; then
  echo "[FATAL DATA GUARD] Persistent data directory '$DATA_DIR' is not read-writable by UID $(id -u)." >&2
  exit 1
fi

exec "$@"
