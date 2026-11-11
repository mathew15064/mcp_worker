# ADR 0001: One codebase, Quick Start and Self-host profiles

- Status: Accepted for staged development, **not** an authorization to deploy
- Date: 2026-11-11
- Baseline: `refactor/typescript-ts6` at `94ec834`
- Scope: P0 and P1 foundation; future adapters remain unavailable until validated

## Context

The current application is a persistent Express/TypeScript process. MySQL is
its production database, a bounded in-memory store backs Admin sessions, and
the native Worker holds an outbound WSS connection to an in-memory broker.
The existing SQLite adapter is used for legacy/test compatibility, **not a
supported standalone production configuration**. MCP Streamable HTTP is already
stateless at the HTTP transport layer, but user/OAuth data and Worker jobs
are not stateless.

Users should not need to provision and tune MySQL or Redis to get started.
A fresh Vercel function does not provide a durable, shared SQLite file or a
guaranteed shared in-memory Worker connection across invocations. HTTP
deployment alone cannot promise functional terminal or workspace tools.

## Decision

Keep one repository and the same 19 MCP tool schemas, OAuth `bot_report.*`
scopes, Worker Ed25519 identity and wire format.

| Profile | Runtime | Storage | Execution | First supported release |
| --- | --- | --- | --- | --- |
| `selfhost-mysql` | Persistent Node + Docker | MySQL | Go Worker / WSS | Existing, currently enabled |
| `selfhost-sqlite` | One persistent Node instance | Local SQLite WAL | Go Worker / WSS | P2, not yet enabled |
| `vercel-sandbox` | Vercel Functions | Remote libSQL | Isolated cloud Sandbox | P3-P5, not yet enabled |
| `vercel-worker` | Vercel Functions | Remote libSQL | Durable jobs + external Worker | P6, not yet enabled |

`DEPLOYMENT_MODE`, `STORAGE_DRIVER`, and `EXECUTION_BACKEND` select a
profile. Omitting all three preserves existing MySQL/WSS behavior. Unknown
and mixed combinations are rejected; valid but unfinished profiles fail
closed **before the DB opens or the HTTP/Worker server listens**. The
profile manifest is a contract and a development roadmap, not a switch for
unimplemented features.

No Redis is required merely for MCP's stateless HTTP transport. Durable
OAuth/session storage is mandatory on Vercel. A durable job queue or poll
protocol is required for external Worker execution: a process-local Map
must not be treated as a distributed broker.

## Execution and security boundaries

- Cloud execution must occur in a user-scoped Sandbox, never an arbitrary
  shell in the OAuth/MCP Function. Apply workspace ownership, quotas,
  resource limits, expiration and controlled networking.
- Workers must retain signed identities, explicit enrollment, scoped
  authorization and operation-specific capability checks. Use durable
  job IDs, bounded retries, leases, idempotency, cancellation and ACK
  after result persistence. At-least-once delivery is not exactly-once
  command execution; destructive operations require extra safeguards.
- Cloud Workspace and a user's own machine are different security scopes.
  Cloud Quick Start must not claim it can operate a user's own machine
  without a separate Worker enrollment.
- Provision secrets once, through an authenticated first-owner claim flow.
  Never use fixed credentials, ephemeral Function-local encryption keys or
  public deployment URLs containing secrets.
- Local SQLite is single-instance with a persistent volume and backup/
  restore. No shared writable SQLite file on network-mounted storage.
  MySQL deployments continue to work; never silently convert existing DBs.

## Compatibility, migrations and rollout

The migration runner currently uses MySQL `information_schema` and
`AUTO_INCREMENT`. P2/P3 must add dialect-aware migrations and transactional
initialization; simply switching a driver is invalid. The Admin session
store is in-memory; P4 must add a shared store with revocation/expiry.
The broker stores `connections`, `pending`, and `streams` in Maps;
P5/P6 must introduce independent execution adapters and durable delivery.

The existing main branch, Docker/MySQL install, native Worker and OAuth
contracts remain unchanged until the respective PRs pass review and CI.
P0/P1 branch is based on the TypeScript migration branch; it must not
be merged to main ahead of review of that prerequisite.

## Acceptance gates

1. Contract: unchanged 19 names, schema fingerprint
   `77fec371229586b76437ab2dd0b8bff3101c89d13baa5a223795a8a68d11fdb6`,
   scopes, Ed25519/WSS and installer persistence.
2. Profile selection: legacy default is unchanged; invalid combinations
   fail with `DEPLOYMENT_CONFIGURATION_INVALID`; unfinished profiles fail
   with `DEPLOYMENT_PROFILE_UNAVAILABLE` before network/database startup.
3. Storage: fresh install, concurrent migrations, OAuth refresh/revoke,
   restart, backup/restore, rollback and data-integrity tests for each engine.
4. Remote: HTTPS OAuth PKCE, consent, CSRF, shared sessions and multi-instance
   routing verified from an external client.
5. Execution: each of the 19 tools executes in its advertised environment
   or is explicitly withheld from a limited preview; verify concurrency,
   reconnect, cancellation, idempotency and authorization failures.
6. Release: secret/history review, license obligations, signed artifacts,
   native lifecycle, dependency scans, backups and owner approval.

## Rejected alternatives

- **Local file SQLite on Vercel:** not durable/shared across invocations.
- **A separate Vercel fork:** doubles security/contract maintenance.
- **Replacing MySQL globally:** risks existing users and migrations.
- **In-memory job Maps on serverless:** jobs cannot be found across instances.
- **Announcing a one-click ready deployment at P1:** no cloud DB, auth
  session or Sandbox/Worker adapter is functional at this stage.
