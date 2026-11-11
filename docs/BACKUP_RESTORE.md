# Backup, restore and upgrade

Back up the installer env, application data, and MySQL data as one matched
set. The env includes the encryption key that decrypts the bootstrap; losing
it can make a healthy database unusable. Worker identity/config on each
machine is separate; securely back up its Worker home and installation
metadata before maintenance. Never copy an active identity onto two running
machines. Browser sessions are in memory and are not restored.

The example below is a **cold backup** of the default standalone Linux
installation using the already-built app image as a tar helper. Stop the
stack first to avoid inconsistent InnoDB data. The backup contains sensitive
data, including secrets. Use encrypted storage with restricted access and
an independent off-host copy. Do not commit or upload the files to a public
artifact store. External databases require a database-admin-approved backup
and restore procedure; the legacy npm backup-db command only backs up SQLite.

## Backup (default project)

From the same checkout, after confirming the saved project is bot-report:

    set -e
    umask 077
    backup="$HOME/bot-report-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -m 700 "$backup"
    ./setup.sh --down
    cp -p .env.setup "$backup/installer.env"
    git rev-parse HEAD > "$backup/commit.txt"
    docker image inspect bot-report-app:local --format '{{.Id}}' > "$backup/app-image.txt"
    docker image inspect bot-report-mysql:local --format '{{.Id}}' > "$backup/mysql-image.txt"
    for volume in app-data mysql-data; do
      docker volume inspect "bot-report_${volume}" >/dev/null
      docker run --rm --network none --user 0 --entrypoint sh \
        -v "bot-report_${volume}:/source:ro" bot-report-app:local \
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
      if docker volume inspect "bot-report-restore_$v" >/dev/null 2>&1; then
        echo "Restore destination exists; refusing" >&2
        exit 1
      fi
    done
    sed 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=bot-report-restore/' "$backup/installer.env" > .env.setup-restore
    chmod 600 .env.setup-restore
    export BOT_REPORT_GIT_SHA="$(git rev-parse HEAD)"
    export BOT_REPORT_BUILD_TIME="$(git show -s --format=%cI HEAD)"
    docker compose --env-file .env.setup-restore -p bot-report-restore create --build
    for v in app-data mysql-data; do
      docker run --rm -i --network none --user 0 --entrypoint sh \
        -v "bot-report-restore_$v:/target" bot-report-restore-app:local \
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
