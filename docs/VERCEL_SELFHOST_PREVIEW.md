# Vercel self-hosting — DEVELOPMENT PREVIEW ONLY

> **Not production-ready. Do not advertise a public "Deploy with Vercel" button yet.**
> This branch is an implementation milestone, not a verified one-click release.
> The existing Docker/VPS application is unchanged.

## Goal

A developer clones their own copy from GitHub, provisions Neon PostgreSQL and
Upstash Redis from the Vercel Marketplace, supplies only one private owner
setup key, and signs into a newly claimed independent instance. Their data,
tokens, sessions, OAuth clients and Worker identities must not be shared with
the original author or other forks.

## Work implemented in this milestone

- Separate Vercel HTTP/WS entrypoint (api/index.ts), preserving the Docker server.
- PostgreSQL adapter and a 13-migration PostgreSQL path, tested against a
  disposable PostgreSQL 16 container.
- An Upstash REST-based persistent session store (no memory fallback on Vercel).
- Per-instance HKDF key separation (session and AES-GCM keys) from
  MCP_SETUP_SECRET; each owner must supply a strong random secret and preserve
  it across deploys. **Do not rotate without a planned key migration.**
- A one-time /setup wizard, with CSRF, a private setup-key check, 14+ character
  Admin password hashed using bcrypt, atomic insert into system_settings, and
  a production-environment restriction. There is no publicly claimable
  first-visitor/Admin-by-default flow.
- Runtime prerequisite page returning HTTP 503, not a fake ready state, if
  Neon, Redis, production URL or owner key is missing.
- Vercel build command copies browser JS/CSS into public/assets, since Vercel
  does not serve assets via express.static().
- Existing OAuth/Worker HTTP routes are kept; existing 15-tool MCP catalog is
  not changed.

## Why the public Deploy Button is still blocked

1. **Production distributed Worker acceptance remains incomplete.** This branch
   implements Redis connection leases, cross-instance job queues and results,
   capability enforcement, SSE notifications and fallback polling. Two
   simulated Function instances can pass a Worker MCP job and reject forbidden
   capabilities. Real Upstash SSE, Vercel WebSocket duration/reconnect, queue
   retries and provider cost must still pass live acceptance. The Vercel
   readiness endpoint intentionally remains 503 until then.
2. **Installer artifacts are still unavailable** in a fresh Git clone.
   The new manual GitHub Actions Worker artifact workflow can build and verify
   cross-platform binaries, but does not publish or sign them. A versioned,
   signed or attested GitHub release and verified installer retrieval still
   need implementation before Worker installation can succeed.
3. **Live owner setup acceptance remains pending.** A PostgreSQL SQL conversion
   issue was fixed. A clean PostgreSQL 16 database plus a local Upstash Redis
   REST mock now completes migration, private owner claim, Admin login and
   locked setup. Genuine Upstash and Vercel HTTPS remain unverified.
4. **No independent two-owner isolation test** or OAuth/PKCE+WSS tool call on
   real Vercel. Verify that two fresh GitHub/Vercel projects have distinct
   databases, Redis, tokens and encryption keys and cannot access each other.
5. **No external security/release approval**, signed artifacts or GitHub
   source sync. The source branch is not a public template yet.

## Two-screen Quickstart beta

The new `vercel-template.json` requests Neon Postgres and Upstash Redis
as **two managed products in the Vercel Deploy flow**, preselected via
the Deploy Button `products` query parameter. The user approves their own
provider plan and any charges. Vercel injects storage connection variables
automatically; no database URL or Redis token is manually pasted.

The Deploy Button additionally requests one **`MCP_SETUP_SECRET`** field
filled privately by the new owner inside the Vercel deployment form.
Secrets are **never passed as values in URL parameters or public defaults**.
Compatible Upstash environment aliases are detected at runtime
(`UPSTASH_REDIS_REST_URL/TOKEN` or `KV_REST_API_URL/TOKEN`), and the
canonical origin is derived from Vercel's system environment.

After deployment, the owner opens `/setup`, enters that same secret and
creates a unique Admin password. Database initialization and password
hashing happen in the app, and further owner claims are permanently locked.

The source button and exact workflow are documented in
[VERCEL_QUICKSTART.md](VERCEL_QUICKSTART.md). **This is a developer preview,
not a supported production release**; the Worker binary installer and
real provider/WSS isolation acceptance gates below remain outstanding.

## GitHub / Vercel authorization prerequisite

The owner must connect their GitHub account in Vercel before Git-based
deployments can fetch this public repository. This consent is unavoidable;
a ChatGPT GitHub connector does not grant Vercel Git repository access.
In the first exploratory Vercel deployment the build failed with
git_info_fail before any source compilation because the connected Vercel
account did not expose a GitHub namespace. No application data or secrets
were provisioned. Re-test Git clone/build after the owner connects GitHub.

## Operational boundaries

- A Vercel instance must never connect to alive.locallhost.shop or its MySQL,
  Redis, OAuth tokens, session secrets or Worker identities.
- Persistent state belongs only to the clone's independently provisioned
  stores. Sharing the same Neon/Upstash resource between different owners
  is forbidden; unique Redis key prefixes are an additional defense.
- Function maximum duration is configured as 300 seconds (Hobby maximum
  with Fluid Compute). Workers need backoff and reconnect. Redis is required
  for cross-instance coordination even when the websocket is connected.
- Keep client and DB secrets in Vercel Project secrets. Never embed them in
  Deploy Button query strings or default env variables.
- Review provider plans and costs at provisioning time.
- Do not invoke any migrations or setup on a pre-existing production
  database except with explicit owner approval and verified backups.

## Current verification

- TypeScript build/typecheck: pass
- Node regression tests: 103 tests, 98 pass, 5 skipped, no failures
- Chromium browser tests: 12/12 pass
- Quality baseline: no new lint/format debt
- PostgreSQL 16: 13/13 schema migrations applied
- Blank PostgreSQL database with simulated Upstash REST: secure claim, login,
  locked setup and 15 MCP tool catalog pass
- Distributed relay with two simulated Function instances: successful job,
  rejected forbidden capability, protected lease transitions
- Independent Vercel deployment with genuine Neon/Upstash, real Worker WSS
  and verified installer from a fresh clone: **NOT YET VERIFIED**

## References

- Vercel Express deployment: https://vercel.com/docs/frameworks/backend/express
- Vercel WS GA (Oct 20, 2026): https://vercel.com/changelog/websocket-support-is-now-generally-available
- Function limits: https://vercel.com/docs/functions/configuring-functions/duration
- Marketplace storage: https://vercel.com/docs/marketplace-storage
- Deploy Button: https://vercel.com/docs/deploy-button
