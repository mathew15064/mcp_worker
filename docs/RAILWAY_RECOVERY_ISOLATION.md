# Railway One-Click SQLite recovery and instance isolation — T4 v1

**Run:** RUN-RAILWAY-ONECLICK-FINAL-20261113T044633Z-4ac570e7
**Snapshot:** v1 / 2026-11-13T04:46:33Z
**Base:** `ae588a1a56f2561ca2323457463e5b9e203de509`
**PC branch:** `work/railway-final-t4`
**Status:** local encrypted fixture recovery and isolation tested; **remote encrypted storage, real Railway recovery and actual RPO/RTO NOT_TESTED**. This is not authorization to deploy or restore production.

## Scope and security model

Railway SQLite lives on one persistent app volume. Losing that volume loses all database records unless an independently held and usable backup exists. A second directory on the same volume, a local-only off-volume disk, or an unencrypted remote copy is **not** a demonstrated disaster-recovery solution. No script provisions storage, uploads a backup, reads a production key, stops Railway, changes live files, or restores onto an existing volume.

The SQLite exporter (`dist/scripts/backup-db.js`) uses the better-sqlite3 **online SQLite backup API**, not a raw copy of an open WAL database. It checks the claimed administrator, precise `2026-11-12-initial` schema and SQLite `quick_check` before and after snapshot. Export requires an explicit existing source path and destination on another Linux mount, rejecting symlinks, overlapping paths and same-mount destinations. In test mode the logical same-mount override is restricted to files beneath the OS temporary directory; it is never a durable backup.

A completed export includes a JSON manifest, which records file basename, SHA-256, size, schema version and timestamp. The manifest is a commit marker and is written last. Hashes prevent accidental mix-ups and corruption; **plain hashes are not signatures**. Encrypted bundles additionally use AES-256-GCM authentication. The exporter restricts files to 0600, temporary data to 0700 directories and cleans up snapshot/WAL/SHM sidecars. Aborted operations leave no complete manifest.

## Encrypted export: approved test or separately authorized operation only

Encrypted export is opt-in and **requires a separate key file containing exactly 32 raw random bytes** (not a password, hex text or base64 text). The file must be a private 0600 regular file outside both the source data volume and export directory. Do not place it with the backup, in source control, in logs or in the manifest. Real key custody must be authorized, documented and held separately from the off-platform backup provider. Losing the key means ciphertext cannot be recovered.

It also requires a private 0700 **Linux tmpfs staging directory** named `BACKUP_STAGING_DIR`, outside both source and export mounts. The SQLite online snapshot is first assembled in this memory-backed location, then streamed through AES-256-GCM to `BACKUP_EXPORT_DIR`; the temporary SQLite file and any WAL/SHM sidecars are unlinked. The exporter verifies integrity/schema before encryption and stores ciphertext SHA-256, plaintext SHA-256, byte counts, a unique 96-bit nonce and authentication tag in the adjacent manifest. The key is never output. `BACKUP_STAGING_DIR` must have enough RAM/tmpfs capacity for the complete database; otherwise export should fail rather than fall back to plaintext disk. Tmpfs can still be subject to host memory/swap policies; operator approval must assess that environment. No plaintext backup is sent to the destination in encrypted mode.

On a **disposable PC test fixture with a separately mounted export directory**, the command pattern is:

```sh
umask 077
# Example paths are placeholders for disposable local fixtures, NOT production paths.
mkdir -m 700 /dev/shm/t4-fixture-stage
mkdir -m 700 /mnt/independent-fixture-export
mkdir -m 700 /tmp/t4-fixture-keys
openssl rand -out /tmp/t4-fixture-keys/backup.key 32
chmod 600 /tmp/t4-fixture-keys/backup.key
DATABASE_PATH=/tmp/fixture-data/bot_report.sqlite \
RAILWAY_VOLUME_MOUNT_PATH=/tmp/fixture-data \
BACKUP_EXPORT_DIR=/mnt/independent-fixture-export \
BACKUP_STAGING_DIR=/dev/shm/t4-fixture-stage \
BACKUP_ENCRYPTION_KEY_FILE=/tmp/t4-fixture-keys/backup.key \
  node dist/scripts/backup-db.js
```

**Important:** These directories must actually be on different mounts where required; the CLI rejects a fake distinct path on the same filesystem. Do not execute this example with a real Railway `DATABASE_PATH` without a separate owner-approved backup plan. If `BACKUP_ENCRYPTION_KEY_FILE` is absent, the legacy output is **plaintext** with status `BACKUP_EXPORTED_LOCAL`; never upload it as if encrypted. Encrypted status is `BACKUP_EXPORTED_ENCRYPTED_LOCAL`, not `REMOTE_BACKUP_CONFIRMED`.

## Disposable decrypt and restore drill (not a production utility)

The sandbox CLI `scripts/verify-railway-offvolume-restore.cjs` requires `W3_SANDBOX_ONLY=1`. It accepts only a source under the host OS temporary directory and a **different, existing, empty, real** temporary directory. It refuses symlinks, occupied targets, wrong or missing manifests, altered hashes, bad schema, missing owner, damaged SQLite and wrong keys. For encrypted snapshots, `W3_BACKUP_KEY_FILE` must reference the original private raw key, separately from the backup and destination. AEAD authentication and plaintext hash, SQLite `integrity_check` and schema are validated **before** the new `bot_report.sqlite` is published. It cannot overwrite a real or existing database, and never creates cloud resources.

```sh
# Only for a fixture stored beneath /tmp; never pass a production path.
mkdir -m 700 /tmp/t4-new-empty-fixture-volume
W3_SANDBOX_ONLY=1 W3_BACKUP_KEY_FILE=/tmp/t4-fixture-keys/backup.key \
  node scripts/verify-railway-offvolume-restore.cjs \
  /tmp/t4-fixture-export/fixture.sqlite.enc /tmp/t4-new-empty-fixture-volume
```

The same preflight supports old **plaintext** fixture `.sqlite` bundles (no key). An encrypted file and its adjacent manifest are an inseparable recovery pair; do not rename either without an authorized manifest-handling procedure. The drill purposely does **not** implement production restore.

## Off-Railway protection and recovery ownership

Before claiming disaster readiness, the owner must separately approve and verify:

1. An independent off-Railway storage provider and account, remote access controls (least privilege), transport encryption, service credentials, access audit, and object versioning/immutability. A local volume or a Railway volume snapshot does not meet this requirement. Upload **only** the completed `.sqlite.enc` and its matching manifest after checksum verification; no automatic upload is enabled.
2. An independently held backup encryption key and separately recoverable application secret material, including `MCP_SETUP_SECRET` and any other operational encryption/signing credentials required by the deployed version. Protect them in different failure domains, restrict access, record responsible custodians, and test recovery using synthetic substitutes. Database bytes alone cannot recover lost application secrets. Never put real keys in evidence or a Git repository.
3. A funded retention/versioning plan with scheduled exports, integrity checks, tested decrypt-and-restore to a **new** isolated environment, alerting on misses, and explicit deletion/rotation policies. As an **illustrative policy, not an implemented service**, retain 7 daily, 4 weekly and 3 monthly authenticated encrypted recovery points; use provider immutability and verify expired versions are removed safely. Keep prior decryption keys while their snapshots remain retained.
4. A separately approved restore decision: establish the last good encrypted snapshot and key, verify authentic remote retrieval, compare application/schema compatibility, provision a **new empty** volume and isolated application, recover secrets, run checks, confirm owner/OAuth/Worker identities, then permit traffic cutover only after owner approval. Never overwrite a mounted production DB, drop/delete a live Railway volume, or bring up a second active Worker using the same identity. Preserve rollback data.
5. Perform an authorized **nonproduction** cross-host/cloud recovery drill, record backup age, retrieval/decryption duration, boot/service verification duration and return-to-service criteria. Only then may an owner set operational RPO/RTO targets based on measured results.

**RPO:** NOT_MEASURED. A daily schedule would only be a *nominal* 24-hour maximum between successful exports, not a guaranteed RPO (missed uploads and failures increase exposure). **RTO:** NOT_MEASURED. Local fixture restoration time excludes provider retrieval, secret escrow, provisioning, DNS and approval delays. Neither value can be promised from PC tests.

## Identity and independence verification

The Node tests use different process instances, SQLite directories, owner credentials, OAuth PKCE clients/tokens, Ed25519 Worker enrollment and WSS keys, sessions and setup secrets. They refuse cross-instance login, tokens, Worker connections and dispatch, and preserve same-secret owner sessions through restart. SQLite snapshots retain owner, OAuth client, session and Worker *database records*; the associated running Worker private key/state remains machine-specific and must be recovered through its own approved procedure. A different `MCP_SETUP_SECRET` can reject old signed sessions even when the restored database records remain intact.

The real Go WSS test uses two separately enrolled Go Workers, homes and workspaces with per-instance OAuth, command boundaries and reconnect. The disposable Docker exercise uses two original volumes plus a third restored volume, independent fixture owners, distinct setup secrets, loopback-only ports, pre/post-backup markers, restart isolation and a read-only volume refusal. The Docker exercise currently verifies **plaintext** off-volume restore; authenticated encrypted round-trip is verified by the separate Node fixture test. No live Railway, off-host storage, production credentials or production database is accessed.

## Reproduce exactly on Bot Report 2 PC

```sh
cd /root/mcp_worker_railway_final_t4_20261113
T04_LOCAL_TEST_ONLY=1 bash scripts/test-recovery-local.sh
```

The wrapper refuses CI, the wrong branch/base, preconfigured database/volume variables and non-disposable Docker image tags. It runs `npm ci`, local lint/typecheck/build, Node disaster recovery plus encryption and isolation, real Go Worker WSS isolation, and a Docker build + 3-volume restore test. Running as root skips the discretionary-permission read-only Node test; the Docker read-only mount test covers that denial separately. Cloud upload, remote encrypted retrieval, cloud restore, native Windows/macOS Worker acceptance and measured RPO/RTO remain **NOT_TESTED**.

**Release readiness:** off-platform durability is not proven; **owner approval required for any live recovery**. Never translate a PC PASS into a live Railway PASS.
