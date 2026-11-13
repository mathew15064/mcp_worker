# Railway W3-T03: one-click template readiness (REVIEW ONLY / NO-GO)

The authoring entrypoint is `.railway/railway.ts`. It describes exactly **one
Node service, one persistent SQLite volume** at `/app/data` and **one replica**.
No Neon, Upstash, PostgreSQL, Redis, MySQL or second service is required.

**NOT DEPLOYABLE / NOT PUBLISHED.** The SDK source now pins the complete Wave 2
integration snapshot (`review/railway-p15-w2-t05-integration` at
`1d617c9abfaaea8b9feae32da269124d5e3d8fd2`), replacing the obsolete
pre-integration `e7de57a` source. This is only a reproducible **review pin**, not
an owner-approved release. The pinned commit does not contain W3-T03 changes;
do not deploy from it or promote this branch as a release. Before real use,
the owner must approve a final commit containing all accepted code, select its
approved source/ref, and independently validate that exact commit.

## SDK and read-only verification

- Pinned authoring package: `railway@3.12.0`; CLI must be >= 5.42.1
  (upgrade to the current compatible CLI before use).
- Reproducible SDK installation: `npm ci --prefix .railway` (committed lockfile).
  Validate with the **real** `railway@3.12.0` SDK:
  `./.railway/node_modules/.bin/tsx .railway/validate.ts`, and type-check using
  `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 --allowImportingTsExtensions .railway/railway.ts .railway/validate.ts`.
  The SDK checks a real authored graph; this is **not a linked CLI plan**.
- Offline source tests: `npm run build && node --test dist/tests/railway-platform-config.test.js`.
  Source-only assertions run in the checkout. The release image instead checks
  its runtime packaging and does not embed these authoring inputs.
- Optional isolated Docker integration gate (requires local Docker daemon):
  `RAILWAY_DOCKER_INTEGRATION=1 npm run test`. Tests use disposable Docker
  volumes/containers and remove them at exit. Do not run on production hosts.
- In a separately owner-approved **new linked sandbox Railway environment**,
  install the pinned SDK with `npm ci --prefix .railway` and run
  `railway config plan --json`; inspect service, volume and variables before
  approval. The plan is read-only but needs a linked Railway environment.
- **CLI_PLAN_BLOCKED:** there is no verified owner-approved linked Railway
  sandbox, so `railway config plan` was **not** executed. SDK graph validation
  is offline only and cannot prove a live Railway volume/domain configuration.
  Never run `railway config apply`, create paid resources, deploy to production,
  or publish a Template as part of W3-T03.

## Owner handoff: manual steps after separate release approval

These are instructions for a **future owner-approved test instance**, not actions
performed by this task. The current IaC alone is not a public template.

1. **Approve source and cost first:** select the complete final release SHA and
   permitted GitHub ref, verify all CI/release/signing gates and explicitly
   authorize any sandbox, compute and volume billing. Do not use the review pin
   for a live deployment.
2. **Compose resources:** exactly one GitHub-sourced Node app with
   `Dockerfile.railway`, one persistent volume mounted at `/app/data`, and
   **one replica** in a single region. Set `DATABASE_PATH` to
   `/app/data/bot_report.sqlite`, `MCP_PLATFORM=railway`, `PORT=80`,
   `HOST=0.0.0.0`, `RAILWAY_RUN_UID=0`,
   `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0`, and the healthcheck `/healthz`.
   Configure on-failure restart (10 retries). No external DB/cache is needed.
3. **Save a setup secret before first startup:** locally generate a unique
   32-byte base64url value with
   `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`.
   Store it in the owner's password manager, then configure the private
   `MCP_SETUP_SECRET` service variable. `preserve()` keeps an existing value;
   it does **not** auto-generate an owner-recoverable secret. Never store this
   key in a URL, Git commit, CI artifact, public template or chat.
4. **Configure the origin:** enable Railway Public Networking and generate an
   HTTPS hostname; Railway injects `RAILWAY_PUBLIC_DOMAIN` for that service.
   For a DNS/TLS-verified custom host, instead set
   `MCP_PUBLIC_BASE_URL=https://your-host.example` (origin only; no path,
   port, query, credentials or whitespace). Confirm hostname/TLS before
   issuing OAuth client redirect URIs or enrolling Workers.
5. **Claim and validate:** visit `https://YOUR-HOST/setup`, enter the saved
   setup key and a **different** Admin password (14+ characters), then log in
   to the Admin Dashboard. Create an OAuth client with S256 PKCE and verify
   HTTPS issuer and callbacks. After separately approving a signed Go Worker
   release, verify outbound WSS enrollment and a benign MCP invocation.

**Readiness semantics:** `/healthz` is an internal liveness check. `/readyz`
returns 503 until persistent SQLite, canonical origin and owner setup are
complete; do not use it as the pre-setup Railway deployment healthcheck.
The container must refuse ephemeral/forged mounts, then drop from a
root-only volume initializer to UID 1000 for Node. Volume attach occurs at
runtime, not Docker build or pre-deploy.

**Owner secret recovery:** retain the original `MCP_SETUP_SECRET` for the
lifetime of the instance: it derives the session and encrypted settings keys.
If Railway variables are lost, re-enter **the same original secret** from
the password manager and restore a validated off-volume SQLite backup.
Rotating it in place can invalidate sessions and make existing encrypted
settings unreadable. If the original secret is irretrievable, no documented
safe recovery of existing encrypted data exists; do not silently replace it.
Only an explicitly approved fresh instance/data reset is an alternative.

**Hostname change:** update the custom origin and verified DNS/TLS together;
reconcile OAuth redirect URIs and Worker WSS endpoints. Do not trust incoming
Host or forwarded-host headers as canonical external origins.

The Dockerfile path is selected through the documented Railway service variable
`RAILWAY_DOCKERFILE_PATH=Dockerfile.railway`; it is not a service `build`
command. `PORT=80` matches both Node and the healthcheck. The script checks
the actual Linux mount table, symlinks and the node user's write access before
starting; a plain ephemeral `/app/data` or forged volume environment variables
cannot satisfy the mount guard.

Railway mounts volumes only at runtime, not at build/pre-deploy. Do not migrate
existing production SQLite files. Volume-backed services have single-instance
availability and potential redeploy downtime. Back up off-volume, test restore
and confirm pricing and Railway's template-composer settings separately.

## Template readiness decision — NOT PUBLISHED

A future Railway template composer must reproduce the verified service,
runtime Dockerfile, `/app/data` volume, exactly one replica, healthcheck,
restart policy, required owner-recoverable secret, public HTTPS networking
and owner instructions above. The template must **not** add a managed DB,
Redis, Neon, Upstash, a second service or an unrecoverable generated key.

Remaining manual inputs after an approved template exists: **(1)** owner
reviews/bears service and volume cost, **(2)** owner securely supplies/retains
`MCP_SETUP_SECRET`, **(3)** owner enables/verifies the public Railway or custom
HTTPS hostname, and **(4)** owner claims `/setup` and configures OAuth/Worker.
These are real steps; this is not yet one-click-and-done.

**Publication blockers:** no approved final SHA/ref; PR #25 and its stacked
PR ancestry remain draft/review-only; no linked owner-approved sandbox
(`CLI_PLAN_BLOCKED`); no paid Railway project, real Railway volume or live
public HTTPS/WSS verification; signed Worker trust/release remains gated;
no live independent-instance isolation, off-volume recovery and billing
acceptance. Offline SDK, local Docker and CI successes do not clear them.

**Safety:** no `railway config apply`, public template publication, live
provisioning or production deployment has been carried out in W3-T03.

Official references:
- https://docs.railway.com/infrastructure-as-code/reference
- https://docs.railway.com/builds/dockerfiles
- https://docs.railway.com/volumes
- https://docs.railway.com/templates/create
