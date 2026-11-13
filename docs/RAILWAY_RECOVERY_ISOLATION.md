# T4 — Railway SQLite local recovery and instance isolation

**Date:** 2026-11-13. **Pinned base:** 9a817baabdaeb6a019083252dac6ca5077257474.
**Isolated branch:** work/quickstart-local-t04. **Execution:** Bot Report 2
terminal profile PC; disposable local Node, Go and Docker fixtures.

**Decision: LOCAL SANDBOX PASS for tested gates; live Railway NOT_TESTED;
production release NO-GO.** No CI/CD, push, merge, deploy, production
database, production secret or live Railway service was accessed.

## Findings and design

### F-DR-01 — On-volume backup (fixed for local export)

Previously scripts/backup-db.ts stored snapshots in a backups subdirectory
beside DATABASE_PATH (normally the **same Railway data volume**) and called
wal_checkpoint(TRUNCATE) before backing up. That neither protects against
volume loss nor is needed by the SQLite online backup API; a forced checkpoint
can also contend with concurrent WAL writers.

The replacement CLI requires an explicit DATABASE_PATH and an **existing**
BACKUP_EXPORT_DIR, with no dangerous in-volume fallback. It never automatically
loads a .env file. A real source SQLite file and a real export directory are
required; symlinks and export paths inside/containing the data volume are
rejected. The Linux mount-ID check uses /proc/self/mountinfo to distinguish
different mounts even when stat.dev is the same for bind mounts. If source
and export resolve to the same mount, the command fails closed.

The CLI validates PRAGMA quick_check, the exact version
2026-11-12-initial from railway_schema_versions and the claimed owner
bootstrap.admin_password_hash before and after taking a **consistent online
better-sqlite3 backup**. It does not checkpoint/truncate the WAL or copy an
open SQLite file. A unique snapshot is finalized with mode 0600 and a
mode-0600 JSON manifest. The manifest records its basename, byte count,
SHA-256, schema version and timestamp, but no owner hash, keys or secrets.
The manifest is published last; a crash before this leaves an incomplete
bundle which restore rejects. Handled errors remove incomplete artifacts.

For Node-only integration fixtures on a single /tmp filesystem, the
special override requires all of NODE_ENV=test,
BACKUP_ALLOW_LOGICAL_VOLUME_TEST_ONLY=1, and **both** paths beneath the OS
temporary directory. It bypasses only the same-mount check, not the
source-volume path separation; the CLI reports sameMountTestOverride=true.
This is **not** an operational backup option. Docker tests run using a real
separate /app/data mount and off-mount /tmp with no override.

**A completed off-mount snapshot is still only on the local machine.**
The command does not implement remote encrypted object storage, authentication,
versioned retention or off-platform retrieval. An operator must export and
verify the closed snapshot and manifest using separately approved off-host
transport before claiming disaster-recovery durability.

### F-DR-02 — Sandbox restore preflight (strengthened)

scripts/verify-railway-offvolume-restore.cjs remains **test-only**, requiring
W3_SANDBOX_ONLY=1, source/manifest beneath /tmp and a new empty real
destination beneath /tmp. It never overwrites an existing database. Its
refusal gates include missing source or manifest; symlinks; nonempty destination;
incorrect manifest filename/format/size/hash/schema; damaged SQLite; failed
PRAGMA quick_check; missing required tables; unsupported schema; and unclaimed
owner. The script copies to a random staged file, rechecks bytes, SHA-256,
schema, owner and row counts, then atomically publishes bot_report.sqlite.
Failure leaves the destination empty.

SHA-256 and the adjacent manifest defend against accidental corruption and
mismatched copies; they are **not authenticated signatures**. An adversary
who can alter both files could forge a different matching pair. Approved remote
object storage must separately provide access controls, authenticated
integrity, retrieval auditing and versioning.

### F-DR-03 — Identity continuity

A sandbox restore with the matching MCP_SETUP_SECRET keeps claimed-owner
state, sessions, OAuth clients and Worker records. It survives a restart and
accepts an unexpired correctly signed owner session. A second restored copy
using a different secret rejects that session while retaining database records.
Secret-dependent encrypted data is not proven recoverable without matching
secret custody; ensure an approved, separately managed escrow procedure.

### Independent self-hosted instances

The Node integration suite starts **two different OS server processes**,
two SQLite paths, secrets, ports and owner credentials. It rejects cross-instance
owner setup keys and sessions, checks OAuth PKCE clients and access/refresh
token families (including rotation), denies cross-instance Worker enrollment,
Ed25519 signed WSS identity and broker dispatch, and enforces per-Worker
capabilities and harmless command isolation across restarts. The Go E2E test
builds and starts **two actual Go Worker processes** with independent homes,
enrollment states and workspaces, checks separate WSS connections, OAuth
commands, cross-use refusal and reconnect.

The local Docker test runs two Node containers on independent named volumes
with loopback-only ports and distinct setup secrets; its disposable databases
receive **different synthetic fixture owner records**. It calls the actual
backup-db CLI inside one container, copies both backup and manifest to an
isolated host temporary directory, runs preflight restore, then boots a third
volume with the restored data. It checks before/after backup markers, isolation
after three restarts, and refusal of a read-only data mount. It cleans up only
its own named disposable containers and volumes. No untrusted shell commands
are executed; command probes use harmless printf fixtures.

## Repeatable local command (PC only)

From the isolated worktree, with no production DATABASE_PATH or
RAILWAY_VOLUME_MOUNT_PATH environment variable set:

~~~bash
cd /root/mcp_worker_w4_t04_20261113
T04_LOCAL_TEST_ONLY=1 bash scripts/test-recovery-local.sh
~~~

The script refuses CI, the wrong branch/base and preconfigured DB paths. It
runs npm ci, lint, typecheck, build, Node recovery/isolation integration,
full two-Worker Go integration, a locally built Docker image and Docker
restore/isolation checks. It requires local Node, npm, OpenSSL, Go toolchain
support for Go 1.24 modules (GOTOOLCHAIN=auto may obtain a newer toolchain),
a Docker daemon and network/cache access to dependencies. The optional
T04_SKIP_DOCKER=1 is only for **partial** investigations, not full PASS.
The only permitted image tag is t04-railway-sandbox:local. No commands invoke
GitHub Actions, Railway deployment or production databases.

For a separately mounted **disposable** local database already claimed by
its test owner, an illustrative export is:

~~~bash
DATABASE_PATH=/tmp/disposable-volume/bot_report.sqlite \
RAILWAY_VOLUME_MOUNT_PATH=/tmp/disposable-volume \
BACKUP_EXPORT_DIR=/mnt/separate-disposable-export \
  node dist/scripts/backup-db.js

# The completed snapshot must have its adjacent .manifest.json file:
W3_SANDBOX_ONLY=1 node scripts/verify-railway-offvolume-restore.cjs \
  /tmp/disposable-export/snapshot.sqlite /tmp/new-empty-disposable-volume
~~~

The snippets illustrate path requirements, not production commands. Never
use a production database or real owner secret for this rehearsal.

## Local evidence (2026-11-13)

| Gate | Local PC status | Live Railway |
| --- | --- | --- |
| TypeScript build, two independent Node processes/databases | PASS | NOT_TESTED |
| WAL-consistent online backup, before/after markers | PASS | NOT_TESTED |
| SHA-256 manifest, quick_check, schema and claimed owner | PASS | NOT_TESTED |
| Independent restore, restart, same/different secret policy | PASS | NOT_TESTED |
| Missing, corrupt, altered hash, missing manifest, symlink, wrong schema, absent owner, occupied target refusal | PASS | NOT_TESTED |
| Same-mount/on-volume export refusal, restricted fixture override | PASS | NOT_TESTED |
| Session, OAuth, Worker identity/enrollment and command isolation | PASS — two Node processes | NOT_TESTED |
| Two real Go Workers with separate state, WSS, reconnect | PASS | NOT_TESTED |
| Docker export/preflight/restore, 3 volumes, 3 restarts, read-only failure | PASS | NOT_TESTED |
| Read-only Node directory when running tests as root | SKIP — covered separately by Docker read-only mount | NOT_TESTED |
| Off-host encrypted storage, retention, durable retrieval | NOT_TESTED | NOT_TESTED |
| Actual Railway networking, public TLS, volume/project isolation | NOT_TESTED | NOT_TESTED |
| Production data-loss recovery, RPO/RTO, rollback | NOT_TESTED | NOT_TESTED |

Local Docker produced a single-run SHA-256 for a disposable snapshot.
Its value is not a production backup, permanent recovery point or evidence
of Railway durability. The fixtures' credentials and SQLite bytes are not
committed or copied into test logs.

## Risks and separately authorized live acceptance

The remote encrypted backup transport, object-store identity, immutable
retention, retrieval verification, owner/key custody, secure public WSS,
real Railway mounted-volume identity, cost and long-term recovery RPO/RTO
are **outside local T4 verification**. Later live work must use a separately
authorized **nonproduction** Railway project, a real external encrypted
object store and an isolated restore project, measure backup freshness and
recovery time, and test approved rollback procedures without ever overwriting
a mounted live SQLite file. A self-hosted SQLite volume should retain its
single-writer constraints.

**Release gate: live disaster recovery readiness is NOT_TESTED / NO-GO.**
