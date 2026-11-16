# Backup, restore and upgrade

## Verified SQLite snapshot export (standalone and isolated tests)

For a standalone SQLite deployment, run the SQLite online backup tool with `BACKUP_STANDALONE_SQLITE=1`. The operator must separately approve any backup of live data and validate recovery in an isolated environment. Never copy a live WAL file by hand.

`npm run backup-db` refuses implicit source or destination values: specify `DATABASE_PATH`, `RAILWAY_VOLUME_MOUNT_PATH` and `BACKUP_EXPORT_DIR` explicitly. The existing export directory must be a real non-symlink directory on a **different Linux mount** from the SQLite data volume. Never place snapshots in `/app/data/backups` or copy an active WAL database. SQLite's online backup API creates a consistent snapshot, validated against schema and integrity checks (Railway owner claim only for Railway databases); the completed snapshot and manifest include a SHA-256/byte-count check.

The default **unencrypted** output is `*.sqlite` plus `*.sqlite.manifest.json`, with status `BACKUP_EXPORTED_LOCAL`. This is a local snapshot and **not protected remote storage**.

An **encrypted export** additionally requires:

- `BACKUP_ENCRYPTION_KEY_FILE`: an existing 0600 regular file with exactly 32 raw random bytes, stored apart from source and export. Do not commit or upload the key with the bundle.
- `BACKUP_STAGING_DIR`: a private 0700 directory on Linux **tmpfs** outside both data and export mounts, with enough space for the database. This prevents the SQLite plaintext staging file from being written to persistent export disk; host swap and tmpfs operational security still require review.
- The same explicit `DATABASE_PATH`, `RAILWAY_VOLUME_MOUNT_PATH` and separately mounted `BACKUP_EXPORT_DIR`.

The encrypted output is `*.sqlite.enc` plus `*.sqlite.enc.manifest.json` with status `BACKUP_EXPORTED_ENCRYPTED_LOCAL`. It uses AES-256-GCM with a fresh random nonce per backup, authenticated tag, ciphertext SHA-256 and plaintext checksum. The complete encrypted manifest is separately authenticated with HMAC-SHA-256 using an HKDF-derived key (distinct from the AES-GCM key), so changing even valid-looking JSON fields fails restore. An unkeyed SHA-256 is only a corruption detector, not manifest authentication. The key is not included. **Encrypted local export is not remote backup**: after a separate owner-approved plan, the operator must transport the completed bundle to independent off-host versioned storage and test retrieval. Never claim recovery without separately recoverable application secrets (`ADMIN_PASSWORD`, `SESSION_SECRET`, `APP_ENCRYPTION_KEY` for standalone; Railway setup secrets for Railway) and the original encryption key.

The local-only restore preflight is:

```sh
# Source and empty destination must both be disposable directories under /tmp.
W3_SANDBOX_ONLY=1 W3_BACKUP_KEY_FILE=/tmp/fixture-key \
  node scripts/verify-railway-offvolume-restore.cjs \
    /tmp/export/fixture.sqlite.enc /tmp/new-empty-fixture-volume
```

For a **standalone** SQLite snapshot (Admin authority retained in `.env.setup` rather than Railway's DB owner claim), use the same sandbox command with an additional explicit `W3_STANDALONE_SQLITE_TEST_ONLY=1`. This validates all application tables, foreign keys, the encrypted manifest and ciphertext, without requiring Railway's owner hash. The default Railway restore still requires its owner claim. All paths must be private disposable directories under `/tmp`, and the target must be empty. It refuses overwrites, symlinks, missing keys, corrupt data or production paths. No supported production restore has been authorized or performed.

For the **disposable PC transport simulation only**, use `T04_OFFSITE_SIMULATION_ONLY=1` and `T04_LOGICAL_STORE_TEST_ONLY=1` with `node scripts/railway-offsite-simulate.cjs deposit|retrieve SOURCE.sqlite.enc NEW_EMPTY_DIRECTORY`. The simulator refuses plaintext, missing HMAC-shaped manifests, symlinks, occupied stores, unsafe mount assumptions and any key-bearing environment variable. It copies the ciphertext and manifest, verifies readback, and never uploads to a remote provider. A matching independently held key is still required for the **separate** sandbox restore command; syntax or ciphertext checksum checks on a storage host do not substitute for HMAC verification at recovery. Logical same-mount simulation is explicitly **not** an off-host durability test. The standalone SQLite/Compose recovery procedure below remains separate.

**Remote durable storage/restore, cloud IAM, retention enforcement, key recovery, and measured RPO/RTO: NOT_TESTED.** Owner approval is required for any live export/recovery action.

## Standalone SQLite / Compose

The current installer uses **one app service, one app-data volume**. Preserve `.env.setup` (three stable secrets), the SQLite database (including its consistent backup) and Worker identity metadata held separately on each Worker. Never run `docker compose down -v`.

For a new installation, `./setup.sh --init` creates SQLite; subsequent restarts use `./setup.sh`. To stop without data loss, use `./setup.sh --down`.

Use the established SQLite online backup helper. From a controlled maintenance shell with Node 22 and a built checkout, set `DATABASE_PATH` to the *existing* SQLite file and `BACKUP_EXPORT_DIR` to an **existing different-mount** private directory; set `RAILWAY_VOLUME_MOUNT_PATH` to the real data directory, and `BACKUP_STANDALONE_SQLITE=1`. Run `npm run backup-db`. By default it writes a private `.sqlite` snapshot and SHA-256 manifest; for encrypted exports also set `BACKUP_ENCRYPTION_KEY_FILE` and a private tmpfs `BACKUP_STAGING_DIR` as documented above. Do not use the `BACKUP_ALLOW_LOGICAL_VOLUME_TEST_ONLY` test override on actual data.

**Restore drill:** stop the target instance and restore the validated offline snapshot into a *new empty test volume*, with the matching `.env.setup` secrets; inspect manifest SHA-256, SQLite `integrity_check` and `foreign_key_check`, then test Admin login, OAuth, Workers and settings. Never overwrite a live SQLite file or replace the source volume during a drill. No off-host disaster-recovery claim is made without a separately tested restore.

**Development reset:** to start clean, use a new isolated Compose project and let `./setup.sh --init` create its SQLite volume. Do not use a reset command against an existing user installation.
