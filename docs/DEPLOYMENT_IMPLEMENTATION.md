# Quick Start / Self-host delivery plan

This is the implementation tracker for [ADR 0001](adr/0001-deployment-modes.md).
It does not change the current production installation or authorize publishing.

## Status and dependency order

| Gate | Deliverable | Depends on | Status |
| --- | --- | --- | --- |
| P0 | Architecture ADR, tool contract baseline, staging policy | TS6.3 | Foundation drafted |
| P1 | Deployment profile validation and runtime ports | P0 | Initial implementation |
| P2 | Production SQLite local mode, migrations, backups | P1 | Pending |
| P3 | Remote libSQL adapter and migrations | P1 | Adapter + 13 migrations tested locally; remote session/runtime pending |
| P4 | Vercel Express entrypoint, persistent sessions and OAuth | P3 | Pending |
| P5 | SandboxExecutionBackend and workspace lifecycle | P4 | Pending |
| P6 | Durable external Worker jobs, reconnect and streaming | P4 | Pending |
| P7 | Deploy Button, safe owner claim, onboarding | P4/P5 | Pending |
| P8 | Cross-mode CI, external E2E, security/release audit | All | Pending |

## P0: baseline and architecture

- Record baseline commit/tree, lock the static catalog order and schema hash
  via `tests/mcp-tool-contracts.test.ts`, and document storage/execution choices.
- Preserve V2 OAuth scopes and native Worker authentication/framing.
- Keep changes in a branch based on `refactor/typescript-ts6` until PR #2
  is independently reviewed. Do not merge/deploy as part of this plan.

**Accept:** existing 19-tool/PKCE/Worker tests and quality gates pass.

## P1: runtime boundaries

- Define profile selection from environment, with the existing self-host
  MySQL/WSS triple as the only enabled combination.
- Centralize boot/shutdown wiring through storage/session/worker ports.
- Use the generic execution dispatch port in WorkerExecutionService so that
  later Sandbox and durable-Worker backends have an injection seam.
- Forbid unavailable modes at startup, before opening the listener.
- Test defaults, invalid combinations, unimplemented profiles and no-side-
  effect composition.

**Accept:** strict typecheck, source lint and quality ratchet, full Node 26
regression and GitHub CI; no new baseline findings.

## P2: SQLite for one-node self-host

- Port the migrations and schema builder to SQLite without silently
  interpreting MySQL SQL; cover `system_settings`, OAuth token tables,
  Worker ownership, users, audit and session records.
- Add explicit one-node SQLite boot path, persistent volume, safe upgrade,
  busy/transaction handling and backup/restore drill.
- Make installer select SQLite or MySQL; default SQLite only in a deliberate
  new-install flow. Existing MySQL installs must retain their storage choice.
- Add migration-from-MySQL export/import as a separate, opt-in tool.

**Accept:** fresh install, all 19 tool calls, process restart, backup/restore,
schema parity and data migration rejection/success paths tested.

## P3-P4: Vercel HTTP and remote storage

- Build a libSQL adapter with prepared parameters, transactions, atomic
  migration lock and request-safe connection lifecycle.
- Replace file-backed MySQL bootstrap, in-memory Admin sessions and
  runtime-only settings in the Vercel path with durable equivalents.
- Add Vercel Express entrypoint; publish static assets correctly; keep
  current MCP and OAuth URLs unchanged; infer public origin securely.
- Use an authenticated claim-once admin boot flow. Secrets must never be
  stored only in Function memory or exposed in logs/URLs.

**Accept:** Vercel Preview, multiple simultaneous Function instances, OAuth
PKCE, refresh/revoke, CSRF, ownership and HTTP discovery from an external
MCP client, including redeploy/restart.

## P5: cloud execution

- Add Sandbox execution provider with per-owner workspaces, minimal
  privileges, quotas, auto-stop, snapshot/restore and cost controls.
- Implement and validate all advertised MCP tool operations; ensure
  process and terminal streaming semantics match contract or mark preview
  as explicitly limited.

**Accept:** complete tool execution, ownership isolation, process lifecycle,
workspace resume, timeouts and abuse-quota tests on cloud infrastructure.

## P6: external Worker from serverless

- Keep existing Go Worker protocol and key storage unchanged. Introduce
  authenticated long polling or compatible queue delivery and durable
  job state; plan a streaming relay for interactive sessions.
- Add lease expiry, retry budget, dedupe, cancellation, result-before-ACK,
  and execution authority checks when enqueueing and when consuming.

**Accept:** worker reconnects, redeploy during job, duplicate delivery,
stale owner revocation, worker replacement and no unauthorized execution.

## P7: deployment ergonomics

- Create Vercel Deploy Button + Marketplace storage provisioning only after
  a deployment can actually serve OAuth, MCP and a real tool.
- Provide Getting Started wizard: claim owner, connect OAuth client, select
  cloud workspace or enroll a personal Worker with scoped access.
- Provide Self-host Lite install path without MySQL container and Advanced
  MySQL path, plus troubleshooting and migration guide.

**Accept:** a fresh account can deploy, authorize, run a workspace tool,
restart and recover without manually editing database credentials.

## P8: release

Maintain CI matrix for MySQL/WSS, SQLite/WSS, libSQL/Sandbox and
libSQL/durable-Worker. Require independent secret/history and source/license
review, native installer/systemd validation, external HTTPS E2E, updated
SBOM/image scans, release signing, artifact provenance, backup/rollback
runbook and distinct approvals for merge and production release.

**Non-goals for the foundation PR:** Deploy Button, functioning local SQLite
production, Turso, Vercel Functions, Sandbox, Redis, queue or published images.
