# Wave 3 independent Railway — acceptance matrix

**Reviewed 2026-11-13.** This matrix distinguishes source-branch PASS, integrated-head validation and actual live Railway acceptance. Release is **NO-GO**.

| Gate | Status | Evidence and required next step |
|---|---|---|
| Independent TS6 ancestry, excluding Vercel PR #14 history | PASS on T01 | [Guard run 43342140051](https://github.com/mathew15064/mcp_worker/actions/runs/43342140051); re-run on final W3 integration HEAD |
| Old Railway PR #15 still stacked on Vercel PR #14 | BLOCKED (intentional) | PR #15 must not merge into TS6; ancestry guard should report BLOCKED_STACKED for its old SHA |
| Independent Railway T01 CI, image, WSS, signing, release | PASS on T01 | [PR #27](https://github.com/mathew15064/mcp_worker/pull/27), 6 workflow runs PASS |
| W3-T02 signed installer Linux/macOS/Windows | PASS on T02 | [Run 43345555560](https://github.com/mathew15064/mcp_worker/actions/runs/43345555560), all native signing jobs succeeded |
| W3-T02 standalone full CI / release verification | NOT_TESTED | No complete source-head CI/release runs at snapshot; require integrated-head tests |
| W3-T03 Railway real SDK offline graph | PASS on T03 | [Run 43340811089](https://github.com/mathew15064/mcp_worker/actions/runs/43340811089), one service, one volume, one replica |
| W3-T03 Docker volume, backup/restore, non-root | PASS on T03 | Same Railway Docker run; actual Railway volume not tested |
| W3-T03 CI, Go WSS and release verification | PASS on T03 | [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43340811176), [WSS](https://github.com/mathew15064/mcp_worker/actions/runs/43340811242), [release](https://github.com/mathew15064/mcp_worker/actions/runs/43340811196) |
| W3-T04 independent SQLite owner/session/OAuth isolation | PASS in sandbox | [Run 43342298844](https://github.com/mathew15064/mcp_worker/actions/runs/43342298844): dedicated Node isolation test |
| W3-T04 two real Go Workers over independent WSS/MCP | PASS in sandbox | Same run: mandatory dual Go Worker test passed |
| W3-T04 Docker off-volume backup/restore + refusal of read-only storage | PASS in sandbox | Same run: three disposable volumes tested; not remote object-storage recovery |
| Combined integration Node TS/build/lint/quality | NOT_TESTED | [Draft PR #30](https://github.com/mathew15064/mcp_worker/pull/30), await checks of exact final HEAD |
| Combined integration Chromium/Go Linux/macOS/Windows | NOT_TESTED | Await PR #30 exact-head CI |
| Combined integration signed Worker integrity/trust rotation | NOT_TESTED | Await PR #30 exact-head matrix and security negative tests |
| Combined integration Railway Docker/SDK + backup | NOT_TESTED | Await PR #30 exact-head image workflow |
| Combined integration two-instance isolation/recovery | NOT_TESTED | Await PR #30 exact-head dedicated workflow |
| Combined integration live-independent ancestry guard | NOT_TESTED | Await PR #30 exact-head guard; original PR #15 must still fail old stack check |
| Combined release verification, no publishing | NOT_TESTED | Await PR #30 exact-head release verification |
| Approved production Worker public key/version/commit | BLOCKED | No approved signed release; keep HTTP 503 |
| Pin of approved independent source in Railway IaC | BLOCKED | Current `.railway/railway.ts` points to pre-release W2 snapshot |
| Linked Railway CLI plan | NOT_TESTED | Requires approved safe sandbox linkage and read-only plan |
| Live Railway HTTPS/WSS, owner setup, real volume | NOT_TESTED | No paid Railway project authorized or created |
| Two distinct live Railway project/identity isolation | NOT_TESTED | Local sandbox evidence only |
| Encrypted off-platform durable backup and disaster restore | NOT_TESTED | Local off-volume copy only |
| Billable resource / signing / merge / release owner authorization | BLOCKED | No approval or production-change authority |
| Public one-click Template | BLOCKED | No live acceptance, no authorized release artifact |

**Go/no-go: NO-GO.** A green offline CI would still require the live and owner approvals above.
