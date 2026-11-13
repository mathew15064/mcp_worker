# Railway + SQLite — Wave 2 Release Acceptance

**Reviewed 2026-11-13, overall NOT READY.** This matrix reflects the Wave 2 code integration candidate; historical Wave 1 results follow after the divider. Offline success and actual deployment are separate evidence levels.

| Gate | Status | Evidence / remaining action |
|---|---|---|
| Source branch ancestry and no path overlap | PASS | Four source heads share exact Wave 2 baseline e7de57a; compare shows no overlapping paths |
| W2-T01 Node/Go/Chromium and signed Worker checks | PASS | [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43267904490) + [Linux/macOS/Windows signature matrix](https://github.com/mathew15064/mcp_worker/actions/runs/43267904508) |
| W2-T01 release verification (no publishing) | PASS | [Run 43267904512](https://github.com/mathew15064/mcp_worker/actions/runs/43267904512) |
| Approved public signature key, version, artifact | BLOCKED | No production-approved trust pin or authorized signed release; HTTP 503 must remain |
| W2-T02 real Railway SDK offline graph (one app/volume/replica) | PASS | [Real SDK validation + Docker image](https://github.com/mathew15064/mcp_worker/actions/runs/43266687078); source configuration only |
| W2-T02 TypeScript/quality/CI | PASS | [Run 43266686798](https://github.com/mathew15064/mcp_worker/actions/runs/43266686798), cancelled macOS job rerun PASS |
| W2-T02 release verification (no publishing) | PASS | [Run 43266686747](https://github.com/mathew15064/mcp_worker/actions/runs/43266686747) |
| Railway linked CLI plan | NOT_TESTED | Requires owner-approved, linked nonproduction Railway environment |
| Approved immutable template source | BLOCKED | Current IaC SHA intentionally points to pre-release baseline, not approved integrated artifact |
| Docker mount guard, node UID, restart, local backup | PASS | [Railway disposable volume image CI](https://github.com/mathew15064/mcp_worker/actions/runs/43266687078) |
| SQLite schema/owner uniqueness/session/CSRF | PASS | Wave 1 T03 [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43260642364) and [release](https://github.com/mathew15064/mcp_worker/actions/runs/43260642367) |
| Local OAuth S256 and real Go Worker WSS/MCP | PASS | [W2-T03 required Go E2E](https://github.com/mathew15064/mcp_worker/actions/runs/43265791778), [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43265791695) |
| Worker reconnect, replay, scope/capability denial | PASS | W2-T03 mandatory sandbox suite; public Railway connection still NOT_TESTED |
| W2-T04 read-only ancestry unit tests | PASS | [Stack guard unit job](https://github.com/mathew15064/mcp_worker/actions/runs/43335716637) |
| W2-T04 unsafe direct PR #15 merge | BLOCKED | Same guard correctly returns BLOCKED_STACKED / exit 2 because #14 is ancestor |
| Combined candidate CI | NOT_TESTED | [Run 43336416296](https://github.com/mathew15064/mcp_worker/actions/runs/43336416296) pending exact completed result at document authoring |
| Combined candidate Railway Docker + SDK | NOT_TESTED | [Run 43336416409](https://github.com/mathew15064/mcp_worker/actions/runs/43336416409) pending final result |
| Combined candidate signed installers / WSS E2E | PASS | [WSS 43336416380](https://github.com/mathew15064/mcp_worker/actions/runs/43336416380) and [installer 43336416799](https://github.com/mathew15064/mcp_worker/actions/runs/43336416799) required jobs passed |
| Combined candidate release verification | NOT_TESTED | [Run 43336416364](https://github.com/mathew15064/mcp_worker/actions/runs/43336416364) pending final result |
| Live Railway domain, volume, owner, WSS, MCP | NOT_TESTED | No real Railway instance provisioned |
| Off-volume remote backup and independent restore | NOT_TESTED | Only disposable Docker image evidence |
| Two separate deployed projects / secret/token/Worker isolation | NOT_TESTED | Requires owner-approved isolated test environments |
| Public one-click template and release | BLOCKED | No publication or live sign-off |
| Railway compute/volume cost authorization | BLOCKED | No paid resource authorization in this review |
| Merge topology and final security sign-off | BLOCKED | PR #15 stacked on PR #14; explicit owner decision needed |

**Release decision: NO-GO.** Keep signed installer fail-closed and PRs Draft. Consult [Wave 2 findings](RAILWAY_INTEGRATION_REVIEW.md) and [PR stack migration](RAILWAY_PR_STACK_MIGRATION.md).

---

## Historical Wave 1 acceptance (kept for evidence; superseded)

# Railway + SQLite release acceptance matrix (T05)

**Scope:** Review snapshot based on GitHub. `PASS` means verified at the stated scope; `NOT_TESTED` means no evidence, `BLOCKED` means a mandatory prerequisite not met. Do not equate CI with production deployment.

| Gate | Status | Evidence and outstanding criterion |
|---|---|---|
| Baseline Node / TypeScript / lint / Chromium / Go platforms | PASS | [Baseline CI](https://github.com/mathew15064/mcp_worker/actions/runs/43208220968): 118, 116 pass, 2 skip. |
| Baseline local Docker SQLite volume, restart, non-root, backup/restore | PASS | [Railway image CI](https://github.com/mathew15064/mcp_worker/actions/runs/43208221015). Offline disposable volume only. |
| T03 hardened SQLite schema / migration tests | PASS | [T03 CI](https://github.com/mathew15064/mcp_worker/actions/runs/43260642364): 125 total, 123 pass, 2 skip. [T03 release verification](https://github.com/mathew15064/mcp_worker/actions/runs/43260642367) PASS; combined T05 checks are separate. |
| Secure Setup, owner uniqueness and CSRF | PASS | Baseline/T03 SQLite integration tests; live Railway setup still NOT_TESTED. |
| Session persistence and credential revocation | PASS | T03 isolated tests on temporary SQLite; live deploy not verified. |
| Local OAuth authorization-code S256 PKCE | PASS | Baseline SQLite integration tests; true public Railway OAuth not verified. |
| Signed manifest signer and offline Linux/Windows installer tests | BLOCKED | T01 later platform jobs passed but required CI not fully green at snapshot and public release trust key/version unapproved. |
| Signed macOS installer suite | NOT_TESTED | CI job not yet concluded in reviewed snapshot. |
| Real Worker enrollment / WSS / MCP command via new Railway SQLite | BLOCKED | T04 recent CI still failed on missing marker; later fix being tested. |
| Worker capability denial, replay, reconnect, timeout | BLOCKED | Some loopback tests exist; mandatory full E2E assertion not green. |
| One Railway service + one persistent volume / one replica | NOT_TESTED | T02 source describes graph; actual SDK CLI plan not verified. |
| Railway public HTTPS hostname | NOT_TESTED | `canonicalRailwayOrigin` static tests; no deployed project. |
| Consistent backup / offline restore | PASS | Disposable Railway image CI; off-volume disaster recovery remains NOT_TESTED. |
| Two-instance isolation | NOT_TESTED | No independent live Railway test instances. |
| Real Railway WSS + MCP | NOT_TESTED | No real connected Railway project. |
| Public one-click Railway template | BLOCKED | Not published; prerequisites and live acceptance missing. |
| Signing-key governance and release approval | BLOCKED | Real key custody, pinned public key, version and binary release not authorized. |
| Railway storage/compute costs and owner authorization | BLOCKED | No approval for provisioning billable Railway resources. |
| Full four-branch integration CI | BLOCKED | T05 candidate includes T03 only; T01/T02/T04 excluded. Combined [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43261916556) and release must finish. |
| PR stack / upstream Vercel separation | BLOCKED | PR #15 is stacked on PR #14. Must review merge topology before merging. |
| Production deploy / merge | BLOCKED | Explicitly outside current review authorization. |

**Overall release state: NOT READY.** Keep Draft PR #15 and all signed-installer fail-closed controls unchanged.

## T05 integration snapshot

- **ACCEPTED:** T03 security source `eeea56ea69779c9d68f7120123dd1d0968030530`; integration candidate commit `d5ca654c8f64bab98167b7ed376aa1a2f0e0bb53`; six modified/added files.
- **BLOCKED:** T01 signed installer CI/release, T02 real Railway SDK and CI, T04 actual Go Worker E2E.
- No production merge, no deployment, no new billing resources, no release signing key.
