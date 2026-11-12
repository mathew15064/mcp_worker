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

1. **Distributed Worker broker** is incomplete. WebSocket connections on
   Vercel Functions are tied to one Function instance, and other instances
   cannot dispatch to that local in-memory Worker map. Redis presence/queue,
   cross-instance job delivery, reconnect, timeouts and multi-instance tests
   are still required. Existing single-process broker is not safe to claim as
   fully operational on Vercel. The Vercel HTTP readiness endpoint must be
   kept unready until this is solved.
2. **Installer artifacts**: Go Worker binaries are not in Git. The Docker
   distribution bundles precompiled Worker binaries, while a fresh Vercel
   GitHub clone currently has only worker/bin/.gitkeep. A versioned,
   checksum-verified and preferably signed Worker release distribution must be
   implemented before installers can succeed.
3. **End-to-end owner setup** is not yet accepted on a deployed Vercel project.
   A local simulation returned 503 during setup and requires further
   investigation. PostgreSQL migrations alone have passed.
4. **No independent two-owner isolation test** or OAuth/PKCE+WSS tool call on
   real Vercel. Verify that two fresh GitHub/Vercel projects have distinct
   databases, Redis, tokens and encryption keys and cannot access each other.
5. **No external security/release approval**, signed artifacts or GitHub
   source sync. The source branch is not a public template yet.

## Intended consumer deployment flow

1. Click Deploy with Vercel on the public, reviewed release (not enabled yet).
2. Vercel clones source into a new repository and project.
3. Add managed Neon and Upstash to that project via Marketplace. Vercel
   injects POSTGRES_URL or DATABASE_URL and UPSTASH_REDIS_REST_URL/TOKEN.
   The new owner must approve their providers/plans, including any charges.
4. Configure a unique MCP_SETUP_SECRET in Vercel's protected Project
   Environment Variables before deploying. It must be a random 43+ character
   base64url key from a trusted password manager or secure random generator.
   Never use the example key, save it in Git, paste it in chat, or share it
   with the author. This is the **one unavoidable manual secret** that proves
   the deployer controls the project.
5. Once runtime checks pass, open /setup, provide that secret and choose a
   distinct, strong Admin password. The wizard saves only the password hash
   and locks further owner claims.
6. Open OAuth Clients, create a ChatGPT client, and enroll a Worker whose
   binary and identity are local to that owner. Test authenticated MCP
   tools/list, runtime_info and workspace_exec.

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

- npm run typecheck: pass
- npm test: 101 tests, 96 pass, 5 skipped, 0 failed (before additional tests)
- npm run build:vercel: pass; public/assets includes admin.js and admin.css
- PostgreSQL 16: 13/13 existing schema migrations applied successfully
- Independent Vercel deployment, distributed Worker MCP, owner wizard and
  binary installer from a fresh clone: **NOT VERIFIED**

## References

- Vercel Express deployment: https://vercel.com/docs/frameworks/backend/express
- Vercel WS GA (Oct 20, 2026): https://vercel.com/changelog/websocket-support-is-now-generally-available
- Function limits: https://vercel.com/docs/functions/configuring-functions/duration
- Marketplace storage: https://vercel.com/docs/marketplace-storage
- Deploy Button: https://vercel.com/docs/deploy-button
