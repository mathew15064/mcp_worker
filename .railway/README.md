# Railway One-Click candidate — T3, REVIEW ONLY

**No Railway template or resource has been published/provisioned.** This is
an offline, independently testable **template composer blueprint**, not a
Railway-importable JSON template or a deploy button.

## Candidate inventory

- **1** Node.js application service: `mcp-worker`, **1** replica, GitHub source
  `mathew15064/mcp_worker`, custom build file `Dockerfile.railway`.
- **1** persistent volume: `sqlite-data`, **512 MB**, `us-west2`, attached at
  `/app/data`. SQLite must be `/app/data/bot_report.sqlite`; WAL/SHM stay there.
- **0** Redis/MySQL/Postgres/Neon/additional services.
- Internal `0.0.0.0:80`, healthcheck `/healthz` (120 s), restart on failure
  (10 retries), no public domain assigned in the offline graph.
- `MCP_SETUP_SECRET` is the **only required owner-provided app variable**. It
  has **no** default: a separately generated, privately retained canonical
  base64url encoding of 32 random bytes (43 chars).
- `RAILWAY_RUN_UID=0` exists solely for root-owned volume initialization. The
  entrypoint enforces real mount + writable path, then `exec su-exec node`
  so PID 1 is UID 1000. A wrong path, absent/fake/read-only volume, unsafe
  SQLite symlink, weak key, or non-root initializer rejects boot.
- `RAILWAY_VOLUME_NAME`, `RAILWAY_VOLUME_MOUNT_PATH` and
  `RAILWAY_PUBLIC_DOMAIN` are **Railway-provided**, not invented by the
  template. Public HTTPS/TLS must be generated and tested by the owner.

`template-candidate.json` is the audited source of **composer parameters**;
`validate.ts` checks it against the real `railway@3.12.0` SDK topology.
Railway's template composer still requires an authorized operator to
configure the service, attach the volume and publish. The JSON cannot
automatically create a real template.

## Release pin: permanently fail closed until separate owner approval

`railway.ts` uses **zero SHA** and
`release/OWNER_APPROVAL_REQUIRED`, deliberately impossible source values.
It accepts only offline SDK `plan` context; `apply`, `deploy`, `template`
and unknown commands throw `RAILWAY_REVIEW_ONLY`. **Do not run Railway CLI
apply/deploy or publish from this candidate.**

After the owner has verified GitHub Actions are disabled at the **remote**
repository (before any push), they may separately authorize publishing the
complete reviewed release commit to a protected, dedicated `release/*`
branch. Then:

1. Independently review the **full 40-character production release SHA**;
   never reuse the PR review SHA or this local integration baseline.
2. Fetch approved source *read-only* into a clean, controlled checkout and run
   `bash .railway/verify-release-pin.sh FULL_SHA release/approved-version`.
   This only compares a **locally cached** `origin/release/*` ref to the
   commit; it does **not** prove fresh GitHub reachability or grant approval.
3. Separately check live GitHub ref reachability, verify the branch tip still
   equals the approved SHA, apply GitHub branch protection/no force-push,
   inspect source integrity, and record reviewer/owner signoff.
4. Submit a **separate reviewed change** replacing both source placeholders
   with the exact approved SHA and protected branch, adjusting the deny guard
   only under specific owner approval. Re-run offline verification.
5. For the Railway **template composer** (which selects a branch URL, not
   this IaC commit override), use the protected exact-release branch URL and
   verify the actual deployed Git SHA equals the approved SHA. If either
   differs, **stop**. Branch update drift remains a risk without protections.

No automatic secret generation, GitHub push, Railway application, domain,
billing, production signing or template publication is authorized here.

## Repeatable PC-only verification

From the T3 isolated worktree:

```sh
npm ci --prefix .railway
.railway/node_modules/.bin/tsx .railway/validate.ts
bash -n .railway/verify-release-pin.sh docker-entrypoint-railway.sh scripts/test-railway-local.sh
npm ci
npm run build
node --test dist/tests/railway-platform-config.test.js dist/tests/railway-platform-config-docker.test.js
docker build -f Dockerfile.railway -t mcp-worker-t3-local:verified .
bash scripts/test-railway-local.sh mcp-worker-t3-local:verified
RAILWAY_DOCKER_INTEGRATION=1 RAILWAY_TEST_IMAGE=mcp-worker-t3-local:verified \
  node --test dist/tests/railway-platform-config-docker.test.js
```

The Docker tests use random, disposable `mcp-t3-*` / `mcp-railway-t3-*`
resources, exercise actual volume/restart/SQLite integrity, Docker health,
owner-not-claimed readiness and negative guards, and remove **only** their
own containers and volumes. A local fake `*.up.railway.app` env value is not
a public URL or HTTPS/TLS verification.

Local tests never invoke Railway APIs, GitHub Actions, cloud provisioning,
remote backups, production signing, or network publishing.

## After separate Railway owner approval: precise live acceptance

1. Owner reviews billing, projected storage/compute, data region, limits and
   backup costs. Owner expressly authorizes a **test project** and deploy.
2. Owner/operator enters candidate values into Railway Template Composer
   (see `docs/RAILWAY_QUICKSTART.md`), configures required user-supplied
   `MCP_SETUP_SECRET` without a default, attaches `/app/data` volume,
   configures healthcheck and Public Networking, and reviews staged changes.
3. In an approved private live test, inspect the project canvas and runtime:
   exactly 1 service/1 replica/1 mounted volume, no external DB, the approved
   Git SHA and Dockerfile, the correct `RAILWAY_VOLUME_*` values, PID1 UID
   1000, writable SQLite/WAL/SHM and persistence across redeploy/restart.
4. Generate/verify a real HTTPS domain and TLS. `/healthz` is HTTP 200,
   `/readyz` HTTP 503 before setup, `/setup` accessible; after owner claim
   confirm required readiness transitions. Check OAuth PKCE callback origin
   and authorized read-only MCP `runtime_info`; signed Worker/WSS separately
   remain blocked until T2's owner-approved release.
5. Verify a separately stored encrypted off-volume backup + independent
   restore plan (T4 owner scope). Test zero-volume/weak-secret negative guards
   in a separate disposable test service, **never against owner production**.
6. Only on **separate publication approval**, publish the reviewed template,
   capture the actual Railway URL, and conduct a fresh first-time owner pilot.

**NOT_TESTED / BLOCKED:** live Railway billing/volume, template import/public
link, TLS/domain, live OAuth/WSS, released signed Worker, off-platform
encrypted backup/restore, remote GitHub Actions setting, release source reachability.

Railway docs: [Template creation](https://docs.railway.com/templates/create),
[Template deployment](https://docs.railway.com/templates/deploy),
[Custom Dockerfile](https://docs.railway.com/builds/dockerfiles),
[Volume environment/permissions](https://docs.railway.com/volumes).
