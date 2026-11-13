# Railway + SQLite — Wave 2 Integration Review

**Decision: PARTIAL ACCEPTANCE / RELEASE BLOCKED.**
**Reviewed: 2026-11-13 (UTC+07).** GitHub-verified, no live Railway project. The section below supersedes the historical Wave 1 snapshot, which is preserved after the divider.

## Exact reviewed sources

| Workstream | SHA pinned | Decision | Evidence |
|---|---|---|---|
| W2-T01 Signed Worker | a2c2e5588f5e1e358f8183aa317676c8680ce5a3 | ACCEPT (offline signing code; no public release) | [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43267904490), [offline Linux/macOS/Windows matrix](https://github.com/mathew15064/mcp_worker/actions/runs/43267904508), [release verification](https://github.com/mathew15064/mcp_worker/actions/runs/43267904512): PASS |
| W2-T02 Railway IaC/Docker | cf803093fcf8ab608f004c0780e4d9b76f71fff0 | ACCEPT for review-only SDK/Docker preview | [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43266686798) PASS after cancelled macOS job rerun; [Railway image](https://github.com/mathew15064/mcp_worker/actions/runs/43266687078), [release](https://github.com/mathew15064/mcp_worker/actions/runs/43266686747): PASS |
| W2-T03 Actual Worker WSS/OAuth/MCP | 49971755d8090d33ad98b18b91592d274334fc44 | ACCEPT offline E2E | [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43265791695), [non-skippable Go Worker E2E](https://github.com/mathew15064/mcp_worker/actions/runs/43265791778), [release](https://github.com/mathew15064/mcp_worker/actions/runs/43265791742): PASS |
| W2-T04 PR stack/readiness | 2e47eac1002fc5467f61364d52d7710924299bc7 | ACCEPT safety guard; deliberate release blocker | [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43335716743) and [release](https://github.com/mathew15064/mcp_worker/actions/runs/43335716557) PASS. [Stack guard](https://github.com/mathew15064/mcp_worker/actions/runs/43335716637): unit PASS, ancestry BLOCKED_STACKED intentionally fails. |

All four task branches descend directly from immutable Wave 2 baseline e7de57a28f4894d302a6dfb24a577ea7b38b9a08. GitHub compared their changed paths; **no pairwise file-path overlaps**. The shared baseline already includes six verified T03 SQLite hardening files from Wave 1 (eeea56ea69779c9d68f7120123dd1d0968030530).

## Integration candidate and provenance

- [Draft PR #25](https://github.com/mathew15064/mcp_worker/pull/25), branch review/railway-p15-w2-t05-integration; base PR #19 branch, not main and not PR #15.
- Import signing + WSS E2E at [c72900b](https://github.com/mathew15064/mcp_worker/commit/c72900bac7c699847fcc11fe16877bec7e607f42).
- Import Railway SDK/IaC + Docker at [0c3874d](https://github.com/mathew15064/mcp_worker/commit/0c3874dc537763a73d70590db15f2b283e265de9).
- Change only Railway image workflow's branch filter at [20e8c7b](https://github.com/mathew15064/mcp_worker/commit/20e8c7b878a150309a967cc59cb839501eb172dd) so that the real image validation is required on this integration candidate instead of silently skipped.
- Import read-only PR stack guard + docs at [65f1fb5](https://github.com/mathew15064/mcp_worker/commit/65f1fb5c9b92836fbe5ad5d143585eeb054fb002).
- GitHub checks on combined candidate: [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43336416296), [Railway image](https://github.com/mathew15064/mcp_worker/actions/runs/43336416409), [real Go E2E](https://github.com/mathew15064/mcp_worker/actions/runs/43336416380), [signed installer matrix](https://github.com/mathew15064/mcp_worker/actions/runs/43336416799), [release verification](https://github.com/mathew15064/mcp_worker/actions/runs/43336416364), [intentional stack guard](https://github.com/mathew15064/mcp_worker/actions/runs/43336416450). Check their exact final conclusions after this report commit; do not infer an all-green suite from individual source runs.

## Security and correctness review

**Signed installer:** T01 uses signed SHA256SUMS, verified Worker release metadata, version/commit pins, tamper/downgrade rejection and fail-safe binary replacement. Test-only ephemeral signing keys are not production keys. APPROVED_WORKER_RELEASE has no approved public key/version/commit. **Railway installer and binary download remain HTTP 503**. Never enable unsigned downloads or claim a public release.

**Railway template:** The pinned railway@3.12.0 SDK and offline graph validation have passed and the disposable Docker image verifies an actual mounted /app/data volume, the non-root runtime, persistence and backup/restore. **The IaC source commit SHA is intentionally a review-only pre-release placeholder**: it must be repinned to an approved immutable, fully integrated release SHA. An offline SDK validation is *not* a linked Railway CLI plan and is not a deployed template.

**OAuth / Worker:** T03 E2E actually builds sandbox Go Worker and exercises loopback WSS, S256 PKCE, an MCP command, reconnect and non-idempotent replay rejection. This is **not live Railway public HTTPS/WSS acceptance**.

**SQLite:** Wave 1 T03 storage hardening and secure owner session handling are part of the baseline. Backups and recovery have been proven on disposable local volumes, not via an independently restored remote Railway volume.

**PR ancestry (critical merge blocker):** Base TS6 → Vercel PR #14: +22 commits; TS6 → Railway PR #15: +42 commits; Vercel PR #14 → Railway PR #15: +20 commits, 0 behind. PR #15 inherits all 22 Vercel commits. The read-only guard intentionally returns **BLOCKED_STACKED / exit 2** to prevent accidental direct merge. An expected red guard is not a reason to weaken CI. Follow [PR stack migration plan](RAILWAY_PR_STACK_MIGRATION.md): separately approve Vercel dependency or create an audited independent Railway patch series.

## Invariants and stop rules

- PR #14, PR #15, PR #19 and PR #25 must stay Draft and unmerged.
- Do not deploy to alive.locallhost.shop, create paid Railway project/volume, publish Worker binaries or public template, alter production keys or execute a production migration.
- Full combined CI green (apart from intentional ancestry blocker) does not authorize merge: cost, owner, independent-instance isolation, off-volume restore, signed release governance, Railway CLI linked plan and real public HTTPS/WSS gates still require approval and live evidence.

**Overall: integrated beta code for review, NOT a public one-click release.**

---

## Historical Wave 1 review (kept for evidence; no longer current)

# T05 — Integration Review of Railway + SQLite self-hosting

**Status:** PARTIAL integration snapshot: exactly six T03 SQLite security files accepted on T05; all other task code excluded. No production merge or deploy.  
**Reviewed:** 2026-11-12 (UTC). **Source of truth:** GitHub branch heads and GitHub Actions logs; worker branches are active and may advance after this snapshot.  
**Repository:** `mathew15064/mcp_worker`  
**Integration base:** `d5c08de9c8b982143350bdd4419af1e4fe98df7e`, Draft PR [#15](https://github.com/mathew15064/mcp_worker/pull/15)  
**Vercel source:** Draft PR [#14](https://github.com/mathew15064/mcp_worker/pull/14), head `fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275`

## Inputs and disposition

| Task | Reviewed head SHA | Evidence / status | Decision |
|---|---|---|---|
| T01 signed Worker | `16b72f0858d2d7b52f25929df9933edcc84006d3` | [PR #18](https://github.com/mathew15064/mcp_worker/pull/18); at this snapshot newer CI and cross-platform workflow incomplete. Previous [CI #107](https://github.com/mathew15064/mcp_worker/actions/runs/43259367369) failed lint. Older Windows suite initially failed binary replacement, but a later [Windows offline job](https://github.com/mathew15064/mcp_worker/actions/runs/43260178404) passed. CI at `7069ecd` failed old HTTP installer contract. | **BLOCKED** pending full green CI, release review, pinned signing public key |
| T02 Railway template | `cba43211ba40063ae021da16039040201611f273` | Has source and offline tests; **no GitHub Action runs or test artifacts attached to head**. IaC test uses in-process mocked `railway/iac` helpers and explicitly does *not* validate official CLI/SDK. | **BLOCKED** pending real SDK/CLI plan verification and CI |
| T03 SQLite security | `eeea56ea69779c9d68f7120123dd1d0968030530` | [PR #17](https://github.com/mathew15064/mcp_worker/pull/17); [CI #](https://github.com/mathew15064/mcp_worker/actions/runs/43260642364) **PASS: 125 tests, 123 pass, 2 skip**. Previously committed CI formatting probe was removed at reviewed head. [Isolated release verification](https://github.com/mathew15064/mcp_worker/actions/runs/43260642367) PASS. | **ACCEPTED into T05 candidate** (six source files); combined CI and release verification remain separate checks |
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

Do not cherry-pick into PR #15 or production. This separate T05 review branch contains **two review documents plus six T03 source files**, integrated at `d5ca654c8f64bab98167b7ed376aa1a2f0e0bb53` from `eeea56ea69779c9d68f7120123dd1d0968030530`. T01/T02/T04 remain excluded. A later integration commit should be created only after:
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

## T05 verified integration actions

- Accepted only **T03 SQLite security** at [`d5ca654`](https://github.com/mathew15064/mcp_worker/commit/d5ca654c8f64bab98167b7ed376aa1a2f0e0bb53), importing exact six T03 blobs from `eeea56ea69779c9d68f7120123dd1d0968030530`. T03 [CI #](https://github.com/mathew15064/mcp_worker/actions/runs/43260642364) and [release verification](https://github.com/mathew15064/mcp_worker/actions/runs/43260642367) passed.
- Consolidated T05 candidate verification triggered: [CI 43261916556](https://github.com/mathew15064/mcp_worker/actions/runs/43261916556) and [release 43261916744](https://github.com/mathew15064/mcp_worker/actions/runs/43261916744); inspect final conclusions before claiming PASS.
- Created [Draft T02 validation PR #20](https://github.com/mathew15064/mcp_worker/pull/20) because T02 branch had no Actions; its first [CI run 43261747973](https://github.com/mathew15064/mcp_worker/actions/runs/43261747973) failed formatting of two new Railway tests. Official Railway SDK/CLI plan remains unverified.
- [T01 release verification 43260726883](https://github.com/mathew15064/mcp_worker/actions/runs/43260726883) failed legacy installer regression. Signed candidate has **no production-approved public key**, so Railway HTTP 503 gate must stay.
- [T04 CI 43260146527](https://github.com/mathew15064/mcp_worker/actions/runs/43260146527) failed Go Worker non-idempotent marker assertion; later commits require independent proof.

Task branches were active during review; this report deliberately pins exact source SHAs and does not imply newly pushed commits were reviewed automatically.
