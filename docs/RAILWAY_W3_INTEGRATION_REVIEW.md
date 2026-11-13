# Wave 3 — Independent Railway integration/security review

**Status: PARTIAL / RELEASE NO-GO.** Reviewed 2026-11-13 (Asia/Ho_Chi_Minh). This is a review-only snapshot on the GitHub W3 integration candidate. No Railway project or public Worker release was created.

## Repo, topology and evidence

- Repository: `mathew15064/mcp_worker`; target independent base: `refactor/typescript-ts6` SHA `2011a0745a36c625aa7f69de7a1b0a6c929313ee`.
- Independent W3-T01 source: `95ac03e3e92b856e548ace68c1d8d34461c67fb1`, [Draft PR #27](https://github.com/mathew15064/mcp_worker/pull/27). It is 3 commits ahead and 0 behind the TS6 base, with no Vercel PR #14 ancestry. Prior old Railway PR #15 **still** includes all 22 Vercel PR #14 commits.
- W3 integration branch: `review/railway-p15-w3-t05-integration`, [Draft PR #30](https://github.com/mathew15064/mcp_worker/pull/30), target base `refactor/typescript-ts6`. The first integration code commit was `b6eba3ca2eba026d1bcd88c93aab232462a9c2a9`, with subsequent commits described below. **Final GitHub Actions must be checked against the current head, not the branch sources.**

| Task | Source commit | Evidence on exact source | Integration disposition |
|---|---|---|---|
| W3-T01 independent Railway | `95ac03e3e92b856e548ace68c1d8d34461c67fb1` | [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43342140078), [Railway image](https://github.com/mathew15064/mcp_worker/actions/runs/43342140082), [release verify](https://github.com/mathew15064/mcp_worker/actions/runs/43342139993), [Go WSS](https://github.com/mathew15064/mcp_worker/actions/runs/43342140107), [signed worker](https://github.com/mathew15064/mcp_worker/actions/runs/43342140055), [strict ancestry](https://github.com/mathew15064/mcp_worker/actions/runs/43342140051): all PASS | **ACCEPT** as independent starting point. Not the same ancestry as W2. |
| W3-T02 signing release policy | `9625fabf91b91a0ab12d1a6f7cbaf9bba8d4b2f7` | [Native signed installer matrix](https://github.com/mathew15064/mcp_worker/actions/runs/43345555560) Linux/macOS/Windows PASS. No complete CI/release verification associated with source head at review snapshot; [Draft PR #28](https://github.com/mathew15064/mcp_worker/pull/28). | **PROVISIONAL CODE IMPORT**; combined security tests and CI mandatory before acceptance. |
| W3-T03 Railway template hardening | `62153099ba5b30c5e510103efa8856635d5fed24` | [CI](https://github.com/mathew15064/mcp_worker/actions/runs/43340811176), [Railway SDK/Docker](https://github.com/mathew15064/mcp_worker/actions/runs/43340811089), [WSS E2E](https://github.com/mathew15064/mcp_worker/actions/runs/43340811242), [release verify](https://github.com/mathew15064/mcp_worker/actions/runs/43340811196): PASS; [Draft PR #26](https://github.com/mathew15064/mcp_worker/pull/26). | **ACCEPT source** for review-only SDK/Docker config, merged without overwriting independent Docker packaging. |
| W3-T04 recovery + isolation | `2e9eb5c46f4888a4dba3cb02068f83031c08e741` | [Sandbox CI](https://github.com/mathew15064/mcp_worker/actions/runs/43342298844): 3 jobs PASS (independent Node/SQLite, real dual Go WSS/MCP, Docker off-volume backup/restore). No complete baseline CI/release verification on source; [Draft PR #29](https://github.com/mathew15064/mcp_worker/pull/29). | **PROVISIONAL TEST IMPORT**, full integrated quality and release checks required. |

## Integration provenance and conflict resolution

No `git merge` of the old Vercel-descendant branch was used. Every imported source was pinned to a reviewed SHA, with exact Git blob reuse where independent-base content matched, and semantic three-way merges where it did not.

1. `b6eba3ca2eba026d1bcd88c93aab232462a9c2a9` — 9 new W3-T04 test/workflow/script/docs files from exact blobs.
2. `bd51092db2eb12e31022f113b8213bb8ec6f8a3c` — 5 unchanged-baseline W3-T03 IaC/origin/test blobs.
3. `70b20d1550e6e9e5f3500d3a12454abf91720465` — three-way merge of `Dockerfile.railway` and Railway image workflow, retaining independent exclusion of Vercel Function code and enabling the W3 integration image/backup gate.
4. `e8f79a3f0c978c1e5498fc32e7840383e6c98f0f` — 4 W3-T02 signer/contract test/policy blobs.
5. `cb31a020a749f68151b7c9ece495476d87667e0a` — three-way merge of `src/routes/workerRoutes.ts` (preserved Railway trusted-origin and pending-release 503) and signed worker artifact workflow; extends cross-platform release-key fingerprint/rotation enforcement.
6. `bbab84aafbe24a14e397de6fb910dea603c2e733` — enable the strict ancestry guard for W3 integration branch.

**File conflicts (semantic/manual):** W3-T02 vs W3-T01 on worker routes and signing workflow; W3-T03 vs W3-T01 on Dockerfile and Railway image workflow. W3-T04 added only new scoped files. No module was replaced wholesale when its independent baseline differed.

## Release-critical security findings

**S1 — Independent ancestry: PASS on T01 source, combined branch requires its own strict check.** Original Vercel PR #14 and stacked Railway PR #15 remain Draft. Verify no new Vercel ancestry after any future base update. Ancestry-safe is not the same as functionally correct or approval to merge.

**S2 — Signing: blocked public release.** Installer checks manifest integrity, cryptographic signature, version/commit, downgrade and pinned trust-root rotation; negative tests and cross-platform matrix passed at source. However the approved public signing trust key, release version/commit and authorized artifact have **not** been issued. Keep Railway `503 WORKER_SIGNED_RELEASE_PENDING`; no real private key in source/CI.

**S3 — Railway template: blocked live deployment.** T03's pinned `.railway/railway.ts` source SHA `1d617c9abfaaea8b9feae32da269124d5e3d8fd2` is a W2 **review-only** source, not the independently integrated release candidate. Do not publish or apply that IaC. The real pinned SDK graph and disposable Docker image pass offline; a linked CLI plan, live volume/HTTPS and approved immutable final source remain untested.

**S4 — Isolation & disaster recovery: sandbox only.** Tests cover distinct processes/owners/OAuth clients/Worker identities, non-replay, off-volume SQLite online backup and independent restore on local Docker volumes. Off-platform encrypted storage, real Railway instances, secret custodians, retention/RPO/RTO and disaster rollback remain NOT_TESTED.

**S5 — Combined CI is a separate, required gate.** The W3 sources do not prove their modified code will coexist correctly on the independent history. Require exact-head Node/TS lint/format, Go Linux/macOS/Windows, Chromium, real Go WSS, signing native matrix, Railway Docker & SDK, Node+Go+Docker isolation, release verification and independent ancestry guard. Any red or missing required job is a release blocker.

## Stop rules and next approvals

No production database, remote SSH, private signing key, public binary, Railway project/volume, external object storage, public template, merge or paid service was touched in this integration. The final release requires owner authorization for (a) release trust key and signed artifact, (b) new Railway costs and linked read-only plan, (c) two fresh live projects/identity isolation, (d) remote off-platform backup + independent restore, (e) final SHA review and merge/publication.

**Decision: integrated review candidate, NOT READY to merge or release.**
