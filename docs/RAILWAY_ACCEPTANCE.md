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
