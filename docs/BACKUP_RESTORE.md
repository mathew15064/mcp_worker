# Backup, restore and upgrade

## Optional SQLite export and encrypted recovery (local test tooling only)

These SQLite backup and restore tools remain available for disposable fixtures or legacy SQLite installations. They are **not** the backup procedure for the default standalone MySQL/Compose deployment below. Do not run them against live data without a separate recovery plan.

`npm run backup-db` refuses implicit source or destination values: specify `DATABASE_PATH`, `RAILWAY_VOLUME_MOUNT_PATH` and `BACKUP_EXPORT_DIR` explicitly. The existing export directory must be a real non-symlink directory on a **different Linux mount** from the SQLite data volume. Never place snapshots in `/app/data/backups` or copy an active WAL database. SQLite's online backup API creates a consistent snapshot, validated against the claimed owner and supported schema; the completed snapshot and manifest include a SHA-256/byte-count check.

The default **unencrypted** output is `*.sqlite` plus `*.sqlite.manifest.json`, with status `BACKUP_EXPORTED_LOCAL`. This is a local snapshot and **not protected remote storage**.

An **encrypted export** additionally requires:

- `BACKUP_ENCRYPTION_KEY_FILE`: an existing 0600 regular file with exactly 32 raw random bytes, stored apart from source and export. Do not commit or upload the key with the bundle.
- `BACKUP_STAGING_DIR`: a private 0700 directory on Linux **tmpfs** outside both data and export mounts, with enough space for the database. This prevents the SQLite plaintext staging file from being written to persistent export disk; host swap and tmpfs operational security still require review.
- The same explicit `DATABASE_PATH`, `RAILWAY_VOLUME_MOUNT_PATH` and separately mounted `BACKUP_EXPORT_DIR`.

The encrypted output is `*.sqlite.enc` plus `*.sqlite.enc.manifest.json` with status `BACKUP_EXPORTED_ENCRYPTED_LOCAL`. It uses AES-256-GCM with a fresh random nonce per backup, authenticated tag, ciphertext SHA-256 and plaintext checksum. The complete encrypted manifest is separately authenticated with HMAC-SHA-256 using an HKDF-derived key (distinct from the AES-GCM key), so changing even valid-looking JSON fields fails restore. An unkeyed SHA-256 is only a corruption detector, not manifest authentication. The key is not included. **Encrypted local export is not remote backup**: after a separate owner-approved plan, the operator must transport the completed bundle to independent off-host versioned storage and test retrieval. Never claim recovery without separately recoverable application secrets (including `MCP_SETUP_SECRET`) and the original encryption key.

The local-only restore preflight is:

```sh
# Source and empty destination must both be disposable directories under /tmp.
W3_SANDBOX_ONLY=1 W3_BACKUP_KEY_FILE=/tmp/fixture-key \
  node scripts/verify-railway-offvolume-restore.cjs \
    /tmp/export/fixture.sqlite.enc /tmp/new-empty-fixture-volume
```

It authenticates ciphertext and key, checks manifest/sha/schema/integrity/owner and publishes only into an empty sandbox target. It refuses overwrites, symlinks, missing keys, corrupt data or production paths. No supported production restore has been authorized or performed.

For the **disposable PC transport simulation only**, use `T04_OFFSITE_SIMULATION_ONLY=1` and `T04_LOGICAL_STORE_TEST_ONLY=1` with `node scripts/railway-offsite-simulate.cjs deposit|retrieve SOURCE.sqlite.enc NEW_EMPTY_DIRECTORY`. The simulator refuses plaintext, missing HMAC-shaped manifests, symlinks, occupied stores, unsafe mount assumptions and any key-bearing environment variable. It copies the ciphertext and manifest, verifies readback, and never uploads to a remote provider. A matching independently held key is still required for the **separate** sandbox restore command; syntax or ciphertext checksum checks on a storage host do not substitute for HMAC verification at recovery. Logical same-mount simulation is explicitly **not** an off-host durability test. The standalone MySQL/Compose backup procedure below remains separate.

**Remote durable storage/restore, cloud IAM, retention enforcement, key recovery, and measured RPO/RTO: NOT_TESTED.** Owner approval is required for any live export/recovery action.

## Standalone MySQL / Compose

Back up the installer env, application data, and MySQL data as one matched
set. The env includes the encryption key that decrypts the bootstrap; losing
it can make a healthy database unusable. Worker identity/config on each
machine is separate; securely back up its Worker home and installation
metadata before maintenance. Never copy an active identity onto two running
machines. Session and encryption secrets must be restored together with the matching database.

The example below is a **cold backup** of the default standalone Linux
installation using the already-built app image as a tar helper. Stop the
stack first to avoid inconsistent InnoDB data. The backup contains sensitive
data, including secrets. Use encrypted storage with restricted access and
an independent off-host copy. Do not commit or upload the files to a public
artifact store. External databases require a database-admin-approved backup
and restore procedure; the legacy npm backup-db command only backs up SQLite.

## Backup (default project)

From the same checkout, after confirming the saved project is mcp_worker:

    set -e
    umask 077
    backup="$HOME/mcp_worker-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -m 700 "$backup"
    ./setup.sh --down
    cp -p .env.setup "$backup/installer.env"
    git rev-parse HEAD > "$backup/commit.txt"
    docker image inspect mcp_worker-app:local --format '{{.Id}}' > "$backup/app-image.txt"
    docker image inspect mcp_worker-mysql:local --format '{{.Id}}' > "$backup/mysql-image.txt"
    for volume in app-data mysql-data; do
      docker volume inspect "mcp_worker_${volume}" >/dev/null
      docker run --rm --network none --user 0 --entrypoint sh \
        -v "mcp_worker_${volume}:/source:ro" mcp_worker-app:local \
        -c 'tar -C /source -cpf - .' > "$backup/$volume.tar"
    done
    (cd "$backup" && sha256sum installer.env commit.txt app-image.txt mysql-image.txt app-data.tar mysql-data.tar > SHA256SUMS)
    ./setup.sh --init

Run these steps in a shell with set -e, or stop immediately on any failure.
For a custom project/env, use its exact saved names in every command.
Verify the backup checksums and test restoration before relying on it.

## Restore drill (new project only)

Use the same approved checkout and matching database image as the backup.
Do not restore over existing volumes. Stop the original installation first
and ensure its Workers will not connect to both instances. This example
uses a new project name and the original port 3333 to preserve the stored
MCP URL. Never run two copies with the same identity/endpoint concurrently.

    set -e
    umask 077
    (cd "$backup" && sha256sum -c SHA256SUMS)
    test "$(git rev-parse HEAD)" = "$(cat "$backup/commit.txt")"
    ./setup.sh --down
    test ! -e .env.setup-restore
    for v in app-data mysql-data; do
      if docker volume inspect "mcp_worker-restore_$v" >/dev/null 2>&1; then
        echo "Restore destination exists; refusing" >&2
        exit 1
      fi
    done
    sed 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=mcp_worker-restore/' "$backup/installer.env" > .env.setup-restore
    chmod 600 .env.setup-restore
    export BOT_REPORT_GIT_SHA="$(git rev-parse HEAD)"
    export BOT_REPORT_BUILD_TIME="$(git show -s --format=%cI HEAD)"
    docker compose --env-file .env.setup-restore -p mcp_worker-restore create --build
    for v in app-data mysql-data; do
      docker run --rm -i --network none --user 0 --entrypoint sh \
        -v "mcp_worker-restore_$v:/target" mcp_worker-restore-app:local \
        -c 'tar -C /target -xpf -' < "$backup/$v.tar"
    done
    BOT_REPORT_SETUP_ENV=.env.setup-restore ./setup.sh --init

The restore uses a fresh set of named volumes; it does not modify the
original. Confirm READY, login, stored settings/users, Worker and OAuth
records, and a fresh read-only MCP call. If recovery fails, stop the restore
project with BOT_REPORT_SETUP_ENV=.env.setup-restore ./setup.sh --down and
restart the original with ./setup.sh --init. Never delete the original until
the restore has been verified and the owner explicitly approves. The backup
is a physical MySQL data snapshot, not a cross-version migration format.
Retain the original image artifacts/digests and checkout for recovery; a
rebuild may not be byte-identical.

## Upgrade and rollback

Read the changelog and run the release verification/scan for the candidate.
Make and verify a cold backup before upgrading. Stop workloads, then use
the same env and project with the approved checkout and ./setup.sh --init.
The script preserves an existing ready source; it refuses unsafe/nonempty
initialization. A schema-changing release needs a separate explicit Admin
migration plan and tested backup/restore. Do not run migration reset/fresh
as recovery. Rollback requires the prior compatible application/database
images and, if schema/data changed, the matching pre-upgrade snapshot.
Worker rollback is separate: see [Worker lifecycle](../worker/README.md).

## Verification evidence

The local P8.6 drill used two disposable Compose projects with the patched
MySQL 8.4.13 image. All six backup files passed SHA-256 verification. The
restored app reached READY and preserved the encrypted bootstrap, 13
migrations, administrator login, seeded user/Worker identity, OAuth token
and the 19-tool MCP catalog. The source volumes were retained until test
cleanup. This verifies same-version cold restore, not cross-version
migration or disaster recovery on a different host.
