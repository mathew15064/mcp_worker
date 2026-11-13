# Railway T3 — PC-only candidate infrastructure (REVIEW ONLY)

This directory defines **one** GitHub-source Node service, **one** 512 MB SQLite
persistent volume mounted at `/app/data`, and **one** replica in `us-west2`.
`Dockerfile.railway` exposes the internal port 80, probes `/healthz` and
drops privileges from a root-only volume initializer to Node UID 1000.
No MySQL, PostgreSQL, Redis, Neon or Upstash resource is provisioned.

## Source pin is deliberately fail-closed

`.railway/railway.ts` pins the exact local review baseline
`9a817baabdaeb6a019083252dac6ca5077257474` by **commit SHA** and the SDK's explicit `main` branch. This branch's
reachability to the candidate SHA is **UNVERIFIED**. This replaces the older Wave 2 review pin
`1d617c9abfaaea8b9feae32da269124d5e3d8fd2`, **not** by declaring a
release. GitHub reachability and independent release ancestry are NOT_TESTED.
The branch must not override the explicit commit SHA; no env override is accepted.
The IaC program rejects every context except `command: 'plan'` with
`RAILWAY_REVIEW_ONLY`; SDK tests verify the rejection of `apply`, `deploy`,
`template`, blank/unknown commands. **Do not attempt live apply or publish.**
That guard is defense-in-depth in the IaC code, not permission to use Railway's
UI or CLI to deploy the unapproved source by another path.

Only after explicit owner approval: replace the review-only pin with the
**complete approved source commit**, confirm that GitHub can actually resolve
it, review the changes to the deny guard, check independent integration and
versioned Worker trust, then validate the exact release again. Approval is
**not** granted by a successful local test.

## Reproducible offline SDK verification on PC

From the root of this isolated worktree:

```sh
npm ci --prefix .railway
./.railway/node_modules/.bin/tsx .railway/validate.ts
npx --no-install tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 --allowImportingTsExtensions .railway/railway.ts .railway/validate.ts
npm run build
node --test dist/tests/railway-platform-config.test.js
./scripts/test-railway-local.sh
```

SDK `railway@3.12.0` is locked. The first command installs dependencies
on the local PC; the graph evaluation and validation run without Railway
credentials or any Railway API calls. The `tsx` command executes the **real**
Railway SDK, not only a mocked TypeScript parse. `test-railway-local.sh`
builds locally and exercises disposable Docker resources named `mcp-t3-*`.
An already-built image may be supplied as its first argument to skip rebuild.
Test script cleanup targets **only** its own named container and volume. No
Docker-wide prune, global cleanup or production resource access is allowed.

`MCP_SETUP_SECRET: preserve()` never creates an operator-recoverable value.
The owner must create and privately retain a unique 32-byte base64url value.
The container rejects an absent or malformed secret; the setup flow relies
on the same key to derive session and encrypted-settings secrets. Do not rotate
the original value without a separate data migration/recovery procedure.
Never print this value in logs, publish it, or set a Template default.

## Public HTTPS is a separately verified owner action

The IaC intentionally **does not invent** a `*.up.railway.app` hostname:
Railway assigns service-specific public domains at deployment time.
After **separate** live approval, enable **Public Networking -> Generate Domain**
on the one app service and confirm TLS/HTTPS and
`RAILWAY_PUBLIC_DOMAIN`. For a verified custom host, provide a strict
`MCP_PUBLIC_BASE_URL=https://owner-host`; do not trust the incoming Host
header for OAuth origins. The internal container HTTP listener is not a
public HTTPS certificate. A locally faked hostname tests origin parsing only.

The application uses `/healthz` for deploy liveness (200) and `/readyz`
for full setup readiness (503 before owner claim). SQLite data, WAL and SHM
must stay inside one mounted `/app/data`. Runtime checks reject ephemeral
mounts, unsafe SQLite path types and read-only mounts. Single-replica volume
deployments can briefly interrupt sessions/Worker WSS, and off-volume backup
and restore must be validated before production.

**NOT_TESTED / not permitted in T3:** linked Railway `config plan`,
`config apply`, paid project/service/volume, live HTTPS domain, OAuth/WSS
networking, public Template publication, signed Worker release and full
off-volume restore on Railway. No GitHub Actions/CI, push, merge or deploy.

See [owner quickstart](../docs/RAILWAY_QUICKSTART.md) for the target
three-step UI experience once a release is approved.
