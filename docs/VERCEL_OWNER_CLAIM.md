# Vercel Preview: claim-once Admin ownership (P4 service foundation)

**Status: private application service only. No public HTTP claim or Admin login
endpoint is mounted, and no usable public Vercel MCP deployment is enabled.**

## Purpose

A fresh Preview instance must have exactly one human owner before OAuth
consent or tool execution can be exposed. Merely knowing the Preview URL
must never confer ownership. The legacy `env-admin` singleton is deliberately
not reused for serverless identity.

### Secret and provisioning

A future trusted deploy integration will generate a **separate cryptographically
random** `VERCEL_OWNER_CLAIM_TOKEN` (at least 32 characters; random 32 bytes
encoded as base64url is suitable). Provide it as a server-side secret. Do not
reuse `SESSION_SECRET`, add the token to a Deploy Button URL, store it in
the repo, log it, or include it in a public link.

The guarded **disposable Preview CLI** `npm run libsql:provision:preview`
now requires `VERCEL_OWNER_CLAIM_TOKEN` and creates the extra
`preview_owner_claims` table alongside the 13 original application
migrations and encrypted `admin_sessions` table. The previous P4
Preview databases must rerun the explicitly acknowledged provisioning
step **only on a throwaway database** before these checks will pass.

`createPreviewOAuthRuntime()` requires that table to exist and only
SELECTs the schema in serverless startup; neither `claim()` nor schema
creation occurs during a cold start.

### Claim and authentication semantics

- `PreviewOwnerClaimService.claim()` checks the supplied proof using a
  constant-time SHA-256 digest comparison to the configured secret.
- Username must be 3–64 approved characters; password must be 12–256
  characters and is stored as **bcrypt(12)**, never plaintext.
- Under **one write transaction**, the service inserts the one Admin user
  (`preview-owner`) and the primary-key-constrained claim row. A second
  claim, including across independent libSQL clients, cannot create another
  owner. The claim token is never stored in the database.
- `authenticate()` checks the stored password hash and the active role.
  `currentIdentity()` additionally validates `authSource`,
  `sessionVersion`, user ID, role and account status against shared
  database state on every use. Updating `session_version` invalidates
  sessions on all instances.
- There is **no password reset, recovery, ownership transfer or public
  session endpoint in this phase**. The service does not silently promote
  an arbitrary database user to Owner.

### Explicitly missing before public claim/login

A production-quality public handler must supply: HTTPS canonical-origin
checks, origin/CSRF defense, IP/account-based **distributed** rate
limiting, session ID regeneration on login, secure cookies, idempotent
retries, an authorized recovery procedure, safe secret rotation,
appropriate audit events and anti-enumeration messaging. The proof
secret must be delivered only to the intended owner through a trusted
provisioning mechanism. Review of these controls is a **release gate**,
not a follow-up optional enhancement.

No public Admin, OAuth or MCP endpoint may mount this service before
those controls and external HTTPS E2E are verified. In particular, the
`/test-only-login` endpoint in the compiled HTTP test is **never**
included in the runtime application.

## Tests

- Wrong proof and invalid password leave the database unclaimed.
- One-time claim persists across isolated runtime connections; repeated
  claims fail and the password is stored only as a bcrypt hash.
- Two competing claim attempts produce exactly one Admin and one claim.
- Shared session identity is checked against current `session_version`.
- OAuth HTTP test uses a test-only login fixture backed by the real Owner
  service, then verifies CSRF consent, PKCE token exchange across two
  Express instances, revocation, and stale-session rejection.

These use **disposable local libSQL databases**, not a real remote Turso
instance or external Vercel HTTPS Preview. There are no real secrets
in the test fixtures. The Quick Start profile is still unavailable.
