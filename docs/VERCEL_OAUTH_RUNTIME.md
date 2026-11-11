# P4 OAuth runtime composition for Vercel Preview

**Status:** review-only injection foundation. No real Vercel OAuth, MCP
or Worker endpoints are enabled by this implementation.

The earlier [Preview diagnostic](VERCEL_PREVIEW.md) verifies database
readiness without modifying the database. This change adds a separate
`createPreviewOAuthRuntime(environment, adapterFactory)` composition
function for future Express integration.

## Runtime dependencies

- Requires the explicit `vercel/libsql/sandbox` preview profile,
  `VERCEL_PREVIEW_ENABLED=true`, HTTPS `MCP_PUBLIC_BASE_URL`, strong
  stable `SESSION_SECRET`, authenticated probe configuration and a
  remote TLS libSQL URL + token.
- Opens an injected libSQL adapter and verifies that the 13 migrations
  have completed with zero pending migrations. It never runs migration DDL
  or creates accounts when handling a request.
- `LibsqlSessionStore.verifyExisting()` SELECTs the required session
  columns before marking the store available. The session table must be
  provisioned ahead of time via the guarded disposable-schema CLI.
  It does **not** create/repair the session table from a cold start.
- Returns a scoped encrypted session store, secure-cookie Express
  session middleware, `McpOAuthRepository`, `McpOAuthService`, an isolated Owner-claim service, and an
  immutable OAuth policy with a canonical `https://.../mcp` resource.
  No request uses the global MySQL-backed repository/settings singleton.
- Keeps the existing `bot_report.read`, `bot_report.terminal` and
  `offline_access` scopes and bounded TTLs. Unknown/invalid TTL
  overrides cause configuration rejection rather than silent defaults.
- Close the returned runtime after the owning Function lifecycle. It is
  **not** an HTTP handler. OAuth route dependency injection and the
  Owner-claim service exist, but no Vercel public claim/login, consent or
  MCP router is mounted. See [Owner-claim security](VERCEL_OWNER_CLAIM.md).

## Local integration evidence

`tests/vercel-oauth-runtime.test.ts` uses two separate libSQL client
connections to the same disposable on-disk SQLite database (a stand-in
for remote libSQL, **not** persistent Vercel storage). It verifies:

1. Completely uninitialized databases and databases missing the encrypted
   Admin sessions table are rejected, with no implicit schema creation.
2. Policy scopes, HTTPS origin, stable secrets and TTL parsing are
   validated before any connection is opened.
3. Two isolated runtime instances share encrypted Admin sessions and
   durable OAuth client, authorization code, access/refresh rotation,
   replay prevention and token revocation.
4. Instances do not share in-process OAuth repository/service objects
   and do not mutate the migration record set merely by starting.

Additional local HTTP tests now use two Express OAuth routers with injected
per-instance libSQL repositories and real Owner session validation. They
exercise CSRF consent, PKCE redirect/token exchange, revoke and session
revocation across instances. A test-only login fixture is not part of any
runtime endpoint.

These tests do **not** validate remote Turso transactional behavior, a
Vercel HTTPS deployment, public Owner claim/login or consent flows,
static assets, or the 19 MCP tool execution backends.

## Follow-on acceptance gate

Before exposing real `/oauth/*` or `/mcp` routes on Vercel, connect the
now-injectable router and claim-once Owner service to a public **HTTPS-only**
entrypoint with distributed throttling, CSRF/origin enforcement and owner
recovery; run an actual external OAuth client PKCE/consent/revoke E2E,
and provide an execution backend (Sandbox or durable Worker). Maintain the unsupported deployment-profile lock
until those acceptance gates pass.

Do not use disposable test credentials for production, run schema
provisioning on an HTTP GET, or publish a Quick Start button from this PR.
