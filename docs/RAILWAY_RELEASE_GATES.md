# Railway release gates — W2-T04

**Release decision: NOT READY / BLOCKED (GitHub snapshot 2026-11-12).** This is a gate specification and evidence register, **not** production deployment acceptance. W2-T04 makes no deploy, signing, billing, PR base or runtime changes.

## Evidence levels

1. **Offline:** isolated Node/TypeScript/Go tests, disposable SQLite volumes, local OAuth/PKCE, installer signature rejection and Docker build. Offline PASS does not prove live Railway readiness.
2. **CI:** all required checks must pass on the **exact integrated candidate SHA**. Ancestor T03 checks or baseline CI cannot substitute for full four-branch integration.
3. **Live:** owner-authorized test Railway projects with real HTTPS/WSS, persistent volume, signed native Go Worker, OAuth/PKCE, backup restore and independent-instance isolation. No live acceptance was performed in W2-T04.
4. **Pre-merge:** independently reviewed ancestry or explicitly accepted Vercel dependency, security and cost approvals. The current PR #15 fails this gate.

## Status matrix

| Gate | Stage | Evidence | Required before release |
|---|---|---|---|
| Vercel/Railway PR dependency | Pre-merge | GitHub: #14 +22, #15 +42, #14→#15 +20 | **BLOCKED:** choose approved Option A/B from RAILWAY_PR_STACK_MIGRATION.md and confirm final exact SHA and effective diff |
| TypeScript, lint, build, browser, Go and quality | Offline/CI | [Baseline CI](https://github.com/mathew15064/mcp_worker/actions/runs/43208220968) and [T03 CI](https://github.com/mathew15064/mcp_worker/actions/runs/43260642364) passed on separate SHA(s) | **BLOCKED:** pass all required CI on actual T01+T02+T03+T04 integration candidate |
| T01 signed Worker, manifest and installer | CI/offline | [Draft T01 #18](https://github.com/mathew15064/mcp_worker/pull/18) | **BLOCKED:** approved public trust key, signed manifest, SHA256, installer fail-closed tamper/rollback verification for Linux/macOS/Windows and release-key custody |
| T02 Railway one-service, volume and replica | Offline/live | [Draft T02 #20](https://github.com/mathew15064/mcp_worker/pull/20), candidate IaC | **BLOCKED:** genuine SDK/CLI plan and one service/one persistent volume/one replica validation before authorized provisioning |
| T03 SQLite hardening, owner and session | Offline/CI | [T03 CI](https://github.com/mathew15064/mcp_worker/actions/runs/43260642364) + [release verify](https://github.com/mathew15064/mcp_worker/actions/runs/43260642367) | **PARTIAL:** isolated tests PASS; re-run with all changes together, verify CSRF/owner/schema integrity |
| SQLite restart, non-root and mount permissions | Offline/live | [Disposable Railway image CI](https://github.com/mathew15064/mcp_worker/actions/runs/43208221015) | **PARTIAL:** real Railway volume mount, persistence across restart and deploy, no ephemeral path/symlink escape untested |
| Consistent backup and restore | Offline/live | Disposable local SQLite backup/restore in T05 acceptance | **PARTIAL:** encrypted off-volume copy, verified clean restore to independent Railway project and retention / recovery sign-off |
| OAuth authorization code, S256 PKCE and issuer | Offline/live | Local SQLite OAuth/PKCE tests referenced by T05 | **PARTIAL:** live HTTPS issuer, redirect/callback, verifier challenge, client scope and session/CSRF isolation untested |
| T04 Go Worker WSS and MCP command | Offline/live | [Draft T04 #16](https://github.com/mathew15064/mcp_worker/pull/16) | **BLOCKED:** real signed Go Worker connects via outbound WSS to Railway, benign MCP call, reconnect, replay/timeout/capability denial |
| Two independent instance/owner isolation | Live | No live independent Railway projects | **NOT TESTED:** separate projects, volumes, domains, secrets, identities and Workers without cross-project leakage |
| HTTPS/WSS origin and readiness | Live | No live Railway acceptance | **NOT TESTED:** actual TLS hostname, outbound WSS, reconnect after deploy, readiness endpoint and no privileged inbound execution |
| Cost and signing-key governance | Pre-provision/release | No explicit owner authorization for billing or production signing | **BLOCKED:** cost cap, volume/compute approval, release trust root, least-privilege secrets and rollback/backup budget |
| Final security and release authority | Release | PR #14/#15/#19 Draft; no live acceptance | **BLOCKED:** signed review of exact artifact/candidate SHA and explicit release approval. Production-ready must remain FALSE |

## Mandatory pre-merge checklist

- [ ] Record immutable base, PR #14, PR #15 and integrated candidate SHAs, merge-bases, changed paths and guard result; re-evaluate on any movement.
- [ ] Approve either Option A (Vercel fully reviewed and merged first) or Option B (independent audited Railway patch series).
- [ ] Review shared auth/OAuth/Worker/migration/build dependencies, with no accidental Vercel-only history in a Railway-only merge.
- [ ] Integrate T01 signed Worker, T02 Railway topology, T03 SQLite security and T04 WSS E2E on the **same** SHA.
- [ ] Pass Node/TypeScript lint, formatting and quality, typecheck, tests, browser, Go native platforms, race/vet and dependency audit.
- [ ] Verify signed Worker manifest, pinned key and installer failure on unsigned, corrupted, stale or mismatched binary.
- [ ] Verify a single Railway service, replica, volume, non-root permissions and persistent DB after restart/redeploy.
- [ ] Verify consistent off-volume backup and independently restored SQLite database.
- [ ] Complete live owner setup, Admin login/session/CSRF and OAuth Authorization Code S256 PKCE on the real Railway HTTPS domain.
- [ ] Complete actual Go Worker outbound WSS enrollment, benign MCP command, reconnect, timeout, replay and capability denial.
- [ ] Validate two separate live test Railway projects/owners with no shared volume, secrets, sessions, tokens or Worker commands.
- [ ] Obtain explicit owner-approved Railway cost, security/signing, merge, and release go/no-go.
- [ ] Attach timestamped live evidence distinct from offline checks. Keep one-click public release and production deployment blocked.

## Read-only stack guard semantics

Run after a separate operator ref refresh:

    node scripts/check-railway-pr-stack.mjs --json --strict

Current PR #15 should return **BLOCKED_STACKED, strict exit 2**. A red topology CI job means the tool is correctly preventing unsafe direct merges; do **not** waive it to make CI green. Missing refs fail with exit 64. A future PASS_INDEPENDENT proves only commit ancestry, never correct functionality or release approval.

## Rollback/stop conditions

Immediately stop on moved SHA, inherited unapproved Vercel history, missing signature, bad CI, insufficient persistent volume/backup evidence, failed OAuth/PKCE/WSS, cross-instance access or missing billing authorization. Keep last known-good signed artifacts and independent off-volume backup; use reviewed revert/roll-forward PRs and validated migration recovery on future authorized releases. Never force-rewrite protected history as a rollback procedure.

## Related owner-controlled reports

This document supplements but does **not** edit T05-owned [RAILWAY_ACCEPTANCE.md](RAILWAY_ACCEPTANCE.md) or [RAILWAY_INTEGRATION_REVIEW.md](RAILWAY_INTEGRATION_REVIEW.md). New live PASS claims must be recorded by the release owner with exact SHA, project/environment, date and artifacts. **Live Railway acceptance has not occurred; production-ready is FALSE.**
