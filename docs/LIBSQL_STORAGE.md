# P3 libSQL / Turso storage adapter — implementation and safety gates

**Status: partial P3 implementation / review-only. Not deployable on Vercel.**

This module is an additive alternative to MySQL for future Quick Start deployments.
The app's current `selfhost-mysql` profile remains the only enabled runtime;
`vercel-sandbox` and `vercel-worker` continue to fail closed in
`src/deployment/profile.ts`. Neither the production DB nor existing Worker
wire protocol is modified.

## Implemented in this branch

- Exact dependency `@libsql/client@0.18.0` and async
  `LibsqlAdapter` implementing the shared `DatabaseAdapter` contract.
  Supports typed queryOne/queryAll, parameter binding, write transactions,
  rollback, multi-statement SQL, changes and ROWID.
- `LibsqlAdapter.createRemote` validates a secure `libsql://` or
  `https://` URL and a nonempty authentication token; disallows
  `file:`, `:memory:`, embedded credentials, URL query strings and
  plaintext HTTP. Local test clients can be injected directly.
- The 13 existing migrations run under the libSQL dialect, with separately
  created indexes and `sqlite_master` schema discovery. Migration records
  retain their original names and are written in the same transaction as
  each migration's DDL. Bounded busy retries and migration-name rechecks
  handle concurrent writers.
- SQLite cannot add FOREIGN KEY constraints to existing tables. For libSQL
  only, the nullable `owner_user_id` columns and foreign keys are created
  on the initial OAuth/Worker tables. Later ownership migrations install
  indexes and advance the migration version without recreating tables.
  MySQL DDL order and the MySQL adapter remain unchanged. Partial rollback
  of the ownership migration preserves those early-created nullable columns
  and constraints; a full schema reset is destructive.
- Local libSQL regression covers OAuth authorization code + PKCE, refresh
  rotation, replay rejection, revocation, ownership foreign keys, setting
  upserts, user persistence after reopening a database, DDL rollback and
  two concurrent initializers.
- The CI concurrency regression required a stronger lock boundary: **all 13
  migrations now execute in one atomic libSQL write transaction**, retrying
  after bounded `SQLITE_BUSY` failures and rechecking version records.
  The disposable multi-client file test explicitly configures SQLite WAL
  mode and busy timeout; this is not evidence about remote Turso behavior.
- `LibsqlSessionStore` persists Admin sessions with AES-256-GCM; records
  contain only keyed HMACs of session IDs and authenticated ciphertext,
  including CSRF/OAuth one-time values. `touch` only extends an existing
  unexpired record and cannot resurrect logout/revocation. Expired sessions
  can be cleaned up with bounded `pruneExpired()`.
- `createSessionMiddleware` exposes the existing cookie/security policy
  with an injected store. The **default application still uses the memory
  store** until a Vercel runtime is implemented. On Vercel, provision the
  shared database and call `LibsqlSessionStore.initialize()` once during
  boot/provisioning, before attaching HTTP handlers; do not create fresh
  independent session keys in Function invocations.
- Separate HTTP instances share the session cookie and logout state; OAuth
  authorization, token exchange, refresh and revoke also work across two
  client connections to the same disposable libSQL database.

## Limitations and next gates

1. **No real remote Turso test** was run: this branch uses in-memory and
   disposable *local* libSQL databases for tests only. Obtain a throwaway
   Turso test database (never production credentials), verify TLS/token
   connection, multi-instance migration behavior and transactional
   consistency over the actual remote protocol.
2. **No Vercel deployment is enabled.** No Vercel Functions entrypoint,
   remote database composition, shared Admin session store, claim-once
   bootstrap or durable Worker coordination has been wired.
3. Confirm and enforce foreign key behavior on the remote service. The
   local tests explicitly set `PRAGMA foreign_keys=ON`; remote settings
   and foreign key behavior require independent validation before launch.
4. Add end-to-end user/Worker ownership, OAuth revoke/refresh, audit and
   session consistency tests across concurrent Vercel Functions.
5. Verify the final container / dependency scans, licensing and all
   cross-environment CI checks; follow the release checklist.
6. Preserve the 19 MCP tool names and static schema hash, OAuth scopes,
   Ed25519 Worker identities, native installer state and current MySQL
   install behavior. Do not merge or deploy without code review.

## Developer checks

```sh
npm ci
npm run typecheck
npm run lint
npm run quality:check
npm run build
node --test --test-concurrency=1 dist/tests/libsql-*.test.js
```

Use the project's pinned **Node.js 26.13.0** for tests with native
`better-sqlite3`. The `file:` paths in tests are disposable fixtures,
**not a recommended Vercel database URL**.

## Optional remote connectivity smoke check (non-destructive)

When a separate **disposable** Turso database has been provisioned by its
owner, put its URL and token in a secure local/CI environment (not in this
repository, PR comments, chat messages or command-line arguments):

```sh
LIBSQL_TEST_DATABASE_URL=libsql://<test-db-host>
LIBSQL_TEST_AUTH_TOKEN=<test-only-token>
npm run libsql:verify:remote
```

The example placeholders above are **not credentials**. The probe only
connects, selects SQLite version and reads the migration table status. It
**does not run migrations**, create tables, update data or print the URL/token.
A successful probe is not a substitute for remote transactional, concurrency,
foreign-key and OAuth E2E testing on an isolated database.

For future Vercel integration, use a separately provisioned stable
`SESSION_SECRET` (32+ characters) for all instances and inject a single
shared `LibsqlSessionStore` into `createSessionMiddleware`. The default
Self-host deployment remains unchanged. The encrypted session schema is
currently created by an **explicit store initialization step**; a production
Vercel bootstrap must perform this safely during provisioning, not once per
request.
