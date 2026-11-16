# Backup, migration and recovery — SQLite-only

The server stores all application data in one SQLite file on a persistent Docker volume.
Keep the **same** `.env.setup` secrets with each installation; Worker identities live on
individual Worker machines and must be preserved separately.

- **Quick Setup:** container `mcp_worker-server`, volume `mcp_worker_quick_app-data`.
- **Source Setup:** Compose service `server`, volume `mcp_worker_app-data`.

Never run `docker compose down -v` or `docker volume rm` when the data matters.
Do not run two server containers writing to the same SQLite volume.

## Backup

For consistent snapshots, use the included SQLite online backup helper, **not**
a raw copy of a running database with WAL files. The explicit parameters are
`DATABASE_PATH` (existing file) and `BACKUP_EXPORT_DIR` (private directory on a
separate real mount). `MCP_WORKER_DATA_DIR` may identify the source volume.
The helper validates the schema, integrity and source/destination separation
before exporting. On the source checkout with Node.js 22 and dependencies:

```sh
# Replace these paths with your own confirmed mounts; keep all paths private.
DATABASE_PATH=/path/to/data/mcp_worker.sqlite \
MCP_WORKER_DATA_DIR=/path/to/data \
BACKUP_EXPORT_DIR=/path/to/separate-mounted-backups \
npm run backup-db
```

The unencrypted snapshot and its manifest are **local files, not off-site backup**.
Encrypted export uses `BACKUP_ENCRYPTION_KEY_FILE` (a mode 0600 raw 32-byte key)
and `BACKUP_STAGING_DIR` (private tmpfs, separate from both volumes).
Preserve the independent key; without it recovery is impossible.

**Recovery drill:** stop the target server, restore to an *empty disposable*
volume using the backed-up secrets, verify SQLite `integrity_check` and
`foreign_key_check`, then test Admin login, OAuth clients and Workers. Never
overwrite a live database. Offsite restore, retention and measured RPO/RTO
remain unverified.

## Explicit migration from the previous SQLite filename

Fresh installations use `mcp_worker.sqlite`. If an old volume still contains
`bot_report.sqlite`, the new server **refuses to initialize a blank database**.
Do not delete that file. Stop the old server and take a verified backup first.

Run the migration tool offline against the **existing** volume using the
matching new image (replace the volume name as appropriate):

```sh
docker run --rm --network none \
  --mount type=volume,src=mcp_worker_app-data,dst=/app/data \
  --entrypoint node mathew15604/mcp-worker:dev-main \
  dist/scripts/migrate-db-filename.cjs --offline
```

The migration uses SQLite's backup API, checks integrity, writes
`mcp_worker.sqlite`, and **retains the original file**. It refuses to overwrite
an existing target. On first startup the application also renames the old
schema ledger to the neutral `schema_versions` within a transaction.
Verify Admin, OAuth and Worker data before considering removal of old files.

## Updates

- **Quick Setup:** `sh quick-setup.sh --down` and `sh quick-setup.sh --start`
  preserve the current image, credentials and volume. New images are never
  adopted silently; back up and perform an explicitly reviewed upgrade.
- **Source Setup:** `./setup.sh --down` then `./setup.sh` uses the matching
  local source image or builds when the committed source has changed.

The signed Go Worker distribution remains independently gated;
`/worker/install*` and `/worker/dist/*` return HTTP 503.
