# Vercel Preview readiness probe (P4 foundation)

**This is a database-only diagnostic Function. It is not a deployable MCP
Quick Start and does not run OAuth login, issue tokens or execute tools.**
All full Vercel profiles remain deliberately disabled. No production deploy
or `main` merge is authorized by this work.

## What is implemented

`api/preview.ts` exports a Vercel Node.js Function at `/api/preview`,
using the documented web handler interface. It checks credentials *server-side*
against a remote libSQL database, verifies the expected migrations, shared
Admin-session schema and claim-once Owner schema, and returns **only status metadata** with
`cache-control: no-store`. It does not print URL/token, run migrations,
create sessions or mutate the DB.

A deliberately separate preview-only flag is mandatory:
- `VERCEL_ENV=preview` (injected by Vercel; **not** production)
- `VERCEL_PREVIEW_ENABLED=true`
- `DEPLOYMENT_MODE=vercel`
- `STORAGE_DRIVER=libsql`
- `EXECUTION_BACKEND=sandbox`
- `SESSION_SECRET` stable, strong, >=32 chars
- `VERCEL_PREVIEW_PROBE_TOKEN` separate random 32+-character bearer token; requests without `Authorization: Bearer <token>` return generic 404 **before opening the database**
- `VERCEL_OWNER_CLAIM_TOKEN` separate cryptographically random bootstrap proof (32+ characters), never logged or placed in a URL, required for the explicit provisioning CLI and future Owner runtime
- `MCP_PUBLIC_BASE_URL` exact HTTPS preview origin (no path/query)
- `TURSO_DATABASE_URL` secure remote `libsql://` or `https://` URL
- `TURSO_AUTH_TOKEN` provisioned as server-side secret

With missing settings, a wrong profile, `VERCEL_ENV=production`, a
database outage or missing migrations/session and Owner-claim schemas, the Function
returns 503 and a generic error code; it **does not** fall back to local
SQLite/MySQL or reveal credential details. Non-GET methods return 405.

Do not expose the repository Deploy Button or describe this probe as a
working MCP endpoint. The existing self-hosted MySQL/WSS app remains unchanged.

## Schema initialization on a disposable preview database

There is an explicit **CLI-only** initializer for a throwaway remote test
database. It is never executed by an HTTP request, not even a GET readiness
probe. The operator first verifies access using
`npm run libsql:verify:remote` (read-only), then sets:
- `VERCEL_PREVIEW_PROVISION_CONFIRM_HOST`: exactly equal to the hostname/port
  of the disposable `TURSO_DATABASE_URL` (no wildcard).
- `VERCEL_PREVIEW_PROVISION_ACK=yes-create-disposable-preview-schema`.
- The same preview-only env values listed above, including a stable
  `SESSION_SECRET`; never pass secrets in CLI arguments or commit them.

Run `npm run libsql:provision:preview` only against the intentionally
disposable database. This **writes schema**, runs the 13 libSQL migrations
transactionally and initializes the encrypted Admin-session and one-time Owner-claim tables. Running it
again should be idempotent. There is no data deletion or reset step, but
accidentally targeting an existing production database would still be unsafe:
the separate host acknowledgement is a guard, not an authorization to migrate
production data.

After the schema is ready, the `/api/preview` probe may return:

```json
{ "ready": true, "service": "mcp_worker", "preview": "database-only", "mcpAvailable": false }
```

Use a preview-only deployment with preview-scoped Turso credentials and
an authorization header for the diagnostic request. This response does
**not** certify OAuth, MCP tools, a running Sandbox, Worker routing or readiness
to publish a Deploy Button. The real remote Turso tests and actual Vercel
deployment require connected, authorized preview infrastructure.

## Unfinished integration gates

1. Provision **throwaway remote Turso** and run the non-mutating
   `npm run libsql:verify:remote`. Never share credentials in PRs or chat.
2. Verify remote libSQL transactional migrations with concurrent clients,
   foreign-key behavior and session storage on the real provider; perform
   schema initialization deliberately via a separate authenticated
   provisioning flow, **not** on a public GET request.
3. Connect the scoped libSQL OAuth runtime and one-time Owner service to the
   **real** Express routes, with audited public claim/login protections,
   stable encryption keys and independent HTTPS security testing.
4. Preserve OAuth metadata/PKCE/CSRF, session revocation and identity across
   cold starts, in external HTTPS E2E. Never use `Map` for cross-instance
   Worker routing; implement Sandbox or durable Worker jobs before
   advertising 19 working tools.
5. Move UI assets into `public/**` for Vercel's CDN. Express static routes
   alone are not served by the Vercel Express integration.
6. Release checklists, signed artifacts and distinct owner review gates are
   still required for production.

Reference: https://vercel.com/docs/functions/runtimes/node-js and
https://vercel.com/docs/frameworks/backend/express.
