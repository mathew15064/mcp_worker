# Railway SQLite — W3-T04 Disaster Recovery, Two-Instance Isolation and Live Acceptance

**Date:** 2026-11-13. **Source baseline:** `review/railway-p15-w2-t05-integration` at
`1d617c9abfaaea8b9feae32da269124d5e3d8fd2`. **Implementation branch:**
`feat/railway-p15-w3-t04-recovery-isolation`.

**Decision: SANDBOX PASS for the observed tests; live Railway NOT_TESTED; release NO-GO.**
This work does not provision a Railway project, deploy a service, access production,
alter production data, sign an installer or make a paid purchase. All passwords,
private keys and enrollment/OAuth tokens in the tests are disposable fixtures.
Never commit database backups, worker identity files, secrets or CI environment dumps.

## Test scope and evidence

| Gate | Local verification on disposable sandbox | Live Railway |
| --- | --- | --- |
| Two independent Node server processes, distinct SQLite paths, HTTPS/WSS ports, secrets and owner credentials | **PASS**, `tests/railway-instance-isolation.test.ts` | **NOT_TESTED** |
| Owner setup key, login/session cookie and session-store isolation in both directions | **PASS** | **NOT_TESTED** |
| OAuth authorization-code S256, distinct clients, access/refresh tokens, cross-client denial and refresh rotation | **PASS** | **NOT_TESTED** |
| Worker enrollment-token ownership, Ed25519 WSS connection, unique Worker identities, cross-broker dispatch rejection | **PASS** | **NOT_TESTED** |
| MCP harmless commands, per-instance Worker capability denial, restart/reconnect | **PASS**, two signed protocol fixtures and **two real Go Workers** | **NOT_TESTED** |
| Online consistent SQLite WAL backup outside live volume; copy to new volume; SHA-256, `quick_check`, schema, owner, sessions, clients, workers, application marker | **PASS**, `tests/railway-disaster-recovery.test.ts` | **NOT_TESTED** |
| Missing/corrupt/unsupported snapshot, corrupt live SQLite: reject without replacing data | **PASS** | **NOT_TESTED** |
| Read-only directory on a non-root Node process | **NOT_TESTED on root host**; required non-root CI job | **NOT_TESTED** |
| Docker two independent mounted volumes, third restored volume, restart and mounted read-only refusal | **PASS**, disposable Docker script | **NOT_TESTED** |
| Off-platform encrypted durable backup delivery, restoration from remote object storage, Railway rollback | **NOT_TESTED** | **NOT_TESTED** |
| Public HTTPS/WSS/TLS, Railway volume identity, real project isolation, CDN/proxy, paid cost validation | **NOT_TESTED** | **NOT_TESTED** |

Test-only transport is bound to `127.0.0.1`. Node fixtures run in separate
OS processes, not merely separate database connections in one shared process.
The IPC fixture refuses environments other than `NODE_ENV=test` and
`MCP_PLATFORM=railway`, requires an independent real path under the OS temporary
directory and never exposes test control operations as an HTTP API.
Go Worker E2E builds a sandbox Worker, enrolls separately to each loopback TLS
server, performs authenticated MCP calls, rejects cross-use and reconnects.
No shell command in acceptance tests operates outside an ephemeral workspace;
`printf` is used as the harmless execution probe.

### Reproduction — nonproduction machine only

Run only in a disposable workspace created from the exact candidate checkout;
never point `DATABASE_PATH` at an existing data directory. Use a non-root
Node environment to cover the directory read-only case.

```bash
npm ci
npm run lint
npm run typecheck
npm run build
node --test --test-concurrency=1 \
  dist/tests/railway-instance-isolation.test.js \
  dist/tests/railway-disaster-recovery.test.js

# Go 1.24+ and OpenSSL; this is required (not skipped) by the dedicated CI job:
BOT_REPORT_W3_T04_GO_E2E=1 \
  node --test dist/tests/railway-instance-isolation-go.test.js

# Docker daemon access only on an approved local test host:
docker build -f Dockerfile.railway -t w3t04-railway-sandbox:local .
W3_SANDBOX_ONLY=1 bash scripts/verify-railway-docker-isolation.sh \
  w3t04-railway-sandbox:local
```

`scripts/verify-railway-offvolume-restore.cjs` **is a test-only restore
preflight**, not a production restore script. It requires
`W3_SANDBOX_ONLY=1` and a new empty destination beneath `/tmp`; it rejects
overwrites, missing or corrupt files, unsupported schema versions, unclaimed
owner data and same-volume paths. The source must be a completed, closed SQLite
online backup. The destination is created by the caller, not the script.

The local Docker script creates only run-prefixed disposable Docker volumes and
containers, binds host ports to loopback, tests the existing Railway image
entrypoint, copies a completed online backup to host temporary storage, restores
it into a third volume and removes **its own** resources on exit. It does not
prune or enumerate unrelated Docker resources for deletion.

### Off-volume backup and recovery evidence

The backup is taken using `better-sqlite3`'s online backup API against an open
WAL database. A committed row is snapshotted before a later write; the restored
volume still contains the *before-backup* value. Tests assert that the backup
directory differs from the active volume, then compare the copy's SHA-256 and
`PRAGMA quick_check`, exact `railway_schema_versions` ledger
(`2026-11-12-initial`), `bootstrap.admin_password_hash` existence (the
Railway owner account), unexpired `env-admin` session policy, persisted OAuth
clients, Worker records and application marker.

The isolated restore starts a fresh server with the original high-entropy
`MCP_SETUP_SECRET`. Owner setup remains locked and an unexpired session signed
with the same secret still authenticates. A second restored copy started with a
different secret must **not** accept the original signed cookie; the SQLite data
remains intact. That does **not** prove encrypted application settings are
recoverable with a mismatched secret.

**Observed local Docker verification:** three independent volumes, three
restarts, refusal of a read-only mounted volume and off-volume SHA-256
`c10f9bc2d09bc5a337a1fe37ee656f4908954766cec47f47783c27f0dbdfeda6`
for a **disposable** image-local test snapshot. This hash is a single-run
reproducibility trace, not a permanent backup object or production evidence.
CI emits its own hashes and TAP summaries; database bytes and credentials
must not be uploaded as CI artifacts.

## Live Railway acceptance runbook (ALL NOT_TESTED)

The following requires a separate explicit owner approval for scope, budget,
new nonproduction Railway projects and secret custodians. Do **not** execute
these instructions as part of W3-T04. Record evidence without logging keys.

1. **Plan and isolate.** Approve costs and two *separate* Railway projects,
   private SQLite volumes, service identities, canonical HTTPS domains, secrets,
   backup destinations and operator access. Confirm a single replica per SQLite
   volume, the intended mount at `/app/data`, and the service's non-root worker
   runtime. Disallow a shared `DATABASE_PATH`, volume identity, domain, backup
   bucket credential, Worker home or enrollment token.
2. **TLS/HTTP readiness.** Verify valid certificate chain, HTTPS redirects,
   expected origin/issuer, `/healthz` and `/readyz` after owner claim, CSRF,
   secure HttpOnly SameSite cookies, rate limiting, and a 503 signed-installer
   gate until a separately approved trust pin and release exist. Test domain
   and proxy forwarding, not just loopback headers.
3. **Identity negative cases.** Create distinct local owner accounts and
   test a wrong cross-project setup key, login and signed session cookie.
   Create separate OAuth S256 clients and refresh token families and prove
   cross-project token rejection in both directions. Verify expiry, refresh
   rotation and capability/scope limits without printing tokens.
4. **Worker isolation.** Enroll two independently signed Go Workers into the
   respective projects over public WSS. Verify each Ed25519 identity,
   capabilities and profile cannot connect or dispatch against the other
   project. Execute only allowlisted harmless `printf` MCP probes in
   disposable workspaces; verify exact output and no execution on the other
   Worker. Disconnect and reconnect each Worker, confirm no command replay.
5. **External disaster-recovery backup.** Create an online, consistent SQLite
   backup using the SQLite backup API or approved `VACUUM INTO` workflow
   (never blindly `cp` an open WAL database). Transfer the completed backup
   **off the Railway volume and off the service host** to approved encrypted
   object storage with access control, retention, integrity hash and tested
   retrieval. Store a separately protected version/secret-custody reference,
   not the secret itself in the backup. Record timestamps, RPO and RTO.
6. **Independent restore rehearsal.** Retrieve the backup into an approved
   new isolated project/volume (not the running instance). Validate file
   existence, size, SHA-256, `PRAGMA quick_check`, schema ledger, owner
   fingerprint policy, settings, sessions, OAuth client/token counts and
   Worker records before advertising readiness. Use the **matching**
   `MCP_SETUP_SECRET` through an approved secret escrow process. Test
   owner login and new sessions, Worker re-enrollment if identity material
   was not captured, and harmless MCP execution.
7. **Failure drills and rollback.** Simulate a missing/corrupt backup and a
   read-only volume in *disposable* projects; the operator must abort rather
   than boot a blank ownerless instance. To roll back an approved deployment,
   disable traffic and writers, capture the current image/volume hash, restore
   a separately verified snapshot while offline, verify schema/owner/session
   compatibility, then shift traffic with a recorded rollback decision.
   Never overwrite a mounted live SQLite file or downgrade an incompatible
   schema in place. Measure actual RPO/RTO and rehearse reversal.

### Findings and blockers outside W3 file ownership

- **F-DR-01 (operational, BLOCKED):** `scripts/backup-db.ts` saves under
  `path.dirname(DATABASE_PATH)/backups`, i.e. **the same Railway volume**.
  Local backup success is not off-volume disaster recovery. This task does
  not change the production backup tool; remote durable export, retention,
  encryption, credential/cost approval and retrieval remain unimplemented/
  unverified.
- **F-DR-02 (recovery safety):** A missing SQLite database on an otherwise
  writable volume is initialized as a fresh schema. Such startup is appropriate
  for first install, but not proof of a restore; the recovery procedure must
  preflight a completed backup and existing claimed owner *before* declaring
  recovered. The sandbox-only restore script refuses missing backups.
- **F-DR-03 (secret continuity):** A restored database with a new
  `MCP_SETUP_SECRET` can mount and initialize but its old signed cookies
  cannot authenticate; secret-dependent encrypted records may also become
  unreadable. `/readyz` is not a secret-escrow verification endpoint.
  Matching secret custody or an authorized rotation/migration is required.
- **F-RELEASE-01 (unchanged):** PR #15 remains Draft with a stacked Git
  ancestry/merge guard; signed installer release trust, Railway template
  approval, live networking, cost and final security sign-off remain blocked.

**No live Railway tests were performed.** Passing disposable Go/Docker
acceptance does not change any live gate from `NOT_TESTED` to `PASS`.
