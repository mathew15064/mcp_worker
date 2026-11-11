#!/bin/sh
set -e

# mcp_worker must be able to start even when MySQL has not been configured yet.
# The persistent data directory stores the encrypted bootstrap connection file
# and, during transition, the read-only legacy SQLite source used for import.
DATA_DIR="${BOT_REPORT_DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"
if [ ! -r "$DATA_DIR" ] || [ ! -w "$DATA_DIR" ]; then
  echo "[FATAL DATA GUARD] Persistent data directory '$DATA_DIR' is not read-writable by UID $(id -u)." >&2
  exit 1
fi

exec "$@"
