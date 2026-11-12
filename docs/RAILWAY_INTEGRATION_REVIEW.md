# T05 — Integration Review of Railway + SQLite self-hosting

**Status:** BLOCKED / review-only snapshot. **No task commits cherry-picked or merged.**  
**Reviewed:** 2026-11-12 (UTC). **Source of truth:** GitHub branch heads and GitHub Actions logs; worker branches are active and may advance after this snapshot.  
**Repository:** `mathew15064/mcp_worker`  
**Integration base:** `d5c08de9c8b982143350bdd4419af1e4fe98df7e`, Draft PR [#15](https://github.com/mathew15064/mcp_worker/pull/15)  
**Vercel source:** Draft PR [#14](https://github.com/mathew15064/mcp_worker/pull/14), head `fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275`

## Inputs and disposition

| Task | Reviewed head SHA | Evidence / status | Decision |
|---|---|---|---|
| T01 signed Worker | `16b72f0858d2d7b52f25929df9933edcc84006d3` | [PR #18](https://github.com/mathew15064/mcp_worker/pull/18); at this snapshot newer CI and cross-platform workflow incomplete. Previous [CI #107](https://github.com/mathew15064/mcp_worker/actions/runs/43259367369) failed lint. Older Windows suite initially failed binary replacement, but a later [Windows offline job](https://github.com/mathew15064/mcp_worker/actions/runs/43260178404) passed. CI at `7069ecd` failed old HTTP installer contract. | **BLOCKED** pending full green CI, release review, pinned signing public key |
| T02 Railway template | `cba43211ba40063ae021da16039040201611f273` | Has source and offline tests; **no GitHub Action runs or test artifacts attached to head**. IaC test uses in-process mocked `railway/iac` helpers and explicitly does *not* validate official CLI/SDK. | **BLOCKED** pending real SDK/CLI plan verification and CI |
| T03 SQLite security | `eeea56ea69779c9d68f7120123dd1d0968030530` | [PR #17](https://github.com/mathew15064/mcp_worker/pull/17); [CI #](https://github.com/mathew15064/mcp_worker/actions/runs/43260642364) **PASS: 125 tests, 123 pass, 2 skip**. Previously committed CI formatting probe was removed at reviewed head. Separate isolated release verification still pending at snapshot. | **PROVISIONAL ACCEPT** subject to release verification and integration checks |
| T04 WSS → MCP E2E | `264709a4cd936b85f343dbdc0751ede075b11bd9` | [PR #16](https://github.com/mathew15064/mcp_worker/pull/16); earlier [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43260146527) FAIL: absent non-idempotent marker in Go Worker E2E. Newer head CI queued. | **BLOCKED** pending green real Go Worker test and no-write-replay proof |

All four task heads descended from the same immutable base `d5c08de9c8b982143350bdd4419af1e4fe98df7e`. The reviewed file-change sets are pairwise **disjoint**, so the merge-conflict map at file-path level is empty. This does **not** prove runtime interoperability.

## Material findings

### S1 — Signed Worker release gate (HIGH)
- Never accept checksum alone: a signed, version-pinned manifest and a pinned verification key are required.
- T01 implements an opt-in offline signer and verification tests. The **production-approved public key/version/commit is still empty**. Railway installer/binary endpoints must keep their current `503 WORKER_SIGNED_RELEASE_PENDING` behavior.
- CI regression has changed across commits; at snapshot, a test expects `install-windows.ps1` whereas the new single-stage Windows script removes that unsafe second-stage download. The correct resolution is to update the contract test with security-equivalent assertions, not reintroduce an unsigned downloader.
- Do not publish a Release/tag or create/handle production signing private keys during T05.

### S2 — Railway IaC proof and provenance (HIGH)
- T02 improved mountinfo validation, node-user writable probe, read-only volume guard, and canonical HTTPS host checks.
- `.railway/railway.ts` currently references task branch `feat/railway-p15-t02-template`. Before a live template it must target a reviewed immutable release source.
- Its offline test evaluates rewritten IaC with mock helpers; this is **not** proof that Railway's actual SDK imports, CLI, resource plan or deployment work. A real `railway config plan` needs a preauthorized nonproduction context.
- No paid Railway resource is authorized or provisioned; public networking, costs, and the one-service/one-volume restriction require live owner acceptance.

### S3 — SQLite and session hardening (MEDIUM)
- T03 adds fail-closed checks for symlinked database / WAL sidecars, path aliases, unsupported schema, corruption, SQLite write probe; migration preservation and session credential rotation tests.
- Temporary formatter probes in runtime source appeared during development, but **were absent from head `eeea56e`**. Re-check immediately before acceptance.
- CI quality gate and 125 Node tests passed at `eeea56e`. Verify isolated release regression and that storage hardening behaves under Railway mounted-volume restrictions before integration.
- Offline SQLite backup/restore proof is not equivalent to off-volume backup and live Railway restore.

### S4 — Worker WSS / MCP actual operation (HIGH)
- T04 uses isolated loopback TLS/WSS, an ephemeral Go Worker identity, SQLite owner claim and OAuth/PKCE.
- An older test incorrectly inspected `stdout_tail`, subsequently changed to `stdout`. The next test failed because the non-idempotent marker file did not exist after an HTTP 200 MCP operation; this remains an E2E correctness blocker until a new run proves execution and replay safety.
- The test's real Go Worker path may skip if prerequisites are unavailable; a skip is not acceptance. Public Railway WSS is not tested.

### S5 — Stacked PR topology (HIGH)
- [PR #15](https://github.com/mathew15064/mcp_worker/pull/15) descends from Vercel PR #14 head: comparing `fd99667` to `d5c08de` reports **20 ahead / 0 behind**. Relative to `refactor/typescript-ts6`, PR #14 has 22 commits and PR #15 has 42.
- Merging PR #15 as-is into the base would carry the Vercel stack too. Before any merge, explicitly decide whether Vercel changes are intended or extract Railway dependencies into a reviewed independent patch series.
- **Neither PR is merged**, and the review branch changes no production service.

## Non-overlapping write map

| Task | Files/modules owned |
|---|---|
| T01 | Worker installer routes, signed manifest script, worker-artifact CI, worker installer tests and README |
| T02 | Railway IaC, Dockerfile and entrypoint, canonical Railway origin and platform-specific tests |
| T03 | SQLite database manager/schema/session store and storage-security tests |
| T04 | New standalone Worker WSS/OAuth/MCP integration test only |
| T05 | `docs/RAILWAY_INTEGRATION_REVIEW.md`, `docs/RAILWAY_ACCEPTANCE.md`, review metadata only |

Semantic dependencies remain: T01's signed release policy impacts T04's installer gate; T02 volumes affect T03's file checks; T04 verifies worker transport using T03 database and T02 origin.

## Integration policy

No cherry-pick into PR #15 or into production. Current review branch contains **only T05 review documents**. A later integration commit should be created only after:
1. Each selected task commit is SHA-pinned and has green required CI; no lingering formatting/runtime probes.
2. Signed installer security and Go Worker E2E actual operation are green, or the incomplete feature remains safely disabled.
3. Conflict and semantic interface review, consolidated CI, Railway image gate, and release verification PASS.
4. No public binary, template, Railway project, secret, merge or production deployment without a distinct approval.

## Evidence index

- E01: [CI baseline — 118 tests](https://github.com/mathew15064/mcp_worker/actions/runs/43208220968) PASS.
- E02: [Railway image baseline](https://github.com/mathew15064/mcp_worker/actions/runs/43208221015) PASS.
- E03: [Release verification baseline](https://github.com/mathew15064/mcp_worker/actions/runs/43208220981) PASS.
- E04: [T01 signed-worker task PR](https://github.com/mathew15064/mcp_worker/pull/18).
- E05: [T03 SQLite task PR](https://github.com/mathew15064/mcp_worker/pull/17), [CI run](https://github.com/mathew15064/mcp_worker/actions/runs/43260642364).
- E06: [T04 WSS task PR](https://github.com/mathew15064/mcp_worker/pull/16), [failed CI run](https://github.com/mathew15064/mcp_worker/actions/runs/43260146527).
- E07: T02 SHA `cba43211ba40063ae021da16039040201611f273` and absent Actions checks; see `tests/railway-platform-config.test.ts` in that commit.

**Review status is not a claim of integration or release readiness.** Re-evaluate actively moving task heads and their current run conclusions before accepting any commit.
