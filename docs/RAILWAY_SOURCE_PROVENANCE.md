# W3-T01 — Source-to-candidate SHA provenance ledger

**Review-only / no release authorization.** 2026-11-13. Directly inspected immutable Git objects and GitHub PR heads in mathew15064/mcp_worker. Source commits were NOT cherry-picked: a reviewed final W2 tree was selectively reconstructed on TS6. This ledger maps all 50 original full SHAs to an included candidate content commit or explicitly excluded historical content. Mapping to a single new SHA does not claim per-hunk or runtime equivalence.

## Exact anchor SHAs

| Anchor | SHA |
|---|---|
| Approved TS6 base | `2011a0745a36c625aa7f69de7a1b0a6c929313ee` |
| Vercel PR14 (+22) | `fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275` |
| Railway PR15 (+42; +20 over Vercel) | `d5c08de9c8b982143350bdd4419af1e4fe98df7e` |
| Immutable W2 PR25 (+50) | `1d617c9abfaaea8b9feae32da269124d5e3d8fd2` |
| W3 independent code (parent TS6) | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| W3 ancestry guard/docs (parent W3 code) | `f3cbe6b4bce3f32588be2ed840a9bb8a012e0a04` |

## Complete source commit disposition (no SHA ancestry from Vercel)

| # | Slice | Original source SHA | Commit subject | Treatment | Candidate commit SHA |
|---:|---|---|---|---|---|
| 1 | Vercel #14 | `ca16b7db7f8e3ac0da2c30632b4111cbc3df2d66` | feat(vercel): scaffold private self-host runtime and guarded owner setup (WIP) | MIXED — selected portable Worker/auth contracts; Vercel-specific components excluded | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 2 | Vercel #14 | `fea2b5151a3d1836b28b582116a27b9f7429896b` | feat(vercel): relay Worker MCP jobs across Function instances (preview) | MIXED — selected portable Worker/auth contracts; Vercel-specific components excluded | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 3 | Vercel #14 | `9d7420f7fbaeb48e73b317542be50871982c7201` | chore(vercel): pin tested Node runtime and document Git authorization gate | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 4 | Vercel #14 | `d45182a06b254a18e481ec81018f3aeb21813d69` | feat(vercel): preconfigure Neon and Upstash in two-screen Quickstart | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 5 | Vercel #14 | `11b7fa9a1dd74353616164e047aa84666d670228` | fix(vercel): atomically bound Worker relay queues and harden dispatch isolation | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 6 | Vercel #14 | `e65d5b761c9e7f986a35ac7a8a4b58518908d62d` | fix(vercel): derive Worker installer origin from trusted Vercel environment | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 7 | Vercel #14 | `b522ac9242d1e7fd59baa41aa834da285cff831d` | style(vercel): address relay quality-gate formatting and typed assertions | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 8 | Vercel #14 | `5661dc559f3e979fd1413978add68dee1342865e` | chore(ci): temporary Prettier diagnostics for relay quality investigation | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 9 | Vercel #14 | `be3041186acb8d9776af5be254cc89b4f5ec72e7` | style(vercel): apply CI Prettier output and remove temporary diagnostics | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 10 | Vercel #14 | `43acec1fa769e0dfce9b91eba735d056b9334295` | fix(ci): supply Vercel test fixtures to disposable release harness | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 11 | Vercel #14 | `b69323c233350fb634fe25de507c296cc3d46330` | fix(ci): compile Vercel entrypoint in builder only and stage Quickstart fixture | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 12 | Vercel #14 | `e8dc395031393380a2dbf3eb9e6ac180458f842f` | fix(quickstart): fail closed on invalid Marketplace configuration | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 13 | Vercel #14 | `3245319dcf09831359d735fafcd813f5443d3fd2` | chore(ci): temporary Quickstart Prettier diagnostic | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 14 | Vercel #14 | `9bbb1477bf45b1ebfa72e9ed908711dd1e404b86` | fix(quickstart): keep OAuth issuer stable across Vercel redeploys | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 15 | Vercel #14 | `092fd93097f7a86320d846967ec010e77948f285` | fix(vercel): refuse stale Worker relay leases and fail fast on reconnect | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 16 | Vercel #14 | `52b17edb225814d6acd6a8bf263b6e00b09cc35a` | fix(quickstart): recover warm Vercel Functions after one-time owner setup | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 17 | Vercel #14 | `80b36f585865b86d2114f6e47ce8bce0efec0592` | fix(setup): release in-process owner claim lock only from its holder | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 18 | Vercel #14 | `9b0c0ecc66381c876b5f3d494ba9ed38bad90193` | test(ci): remove unbound test methods and inspect exact Prettier output | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 19 | Vercel #14 | `57358b9bdf41a4afeab6d26dab09035126304345` | style(quickstart): apply CI Prettier output for relay and setup tests | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 20 | Vercel #14 | `cdd8930e35ba63e8935bfedb649257bb1062b55e` | test(quickstart): add read-only acceptance probe and explicit live gates | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 21 | Vercel #14 | `fb8cf4d9d0ece1d31a54eca347d01208959782c6` | ci(quickstart): reject production or credential-bearing smoke targets | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 22 | Vercel #14 | `fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275` | docs(quickstart): link the read-only acceptance probe from beta guide | EXCLUDED Vercel-only change; shared final-state behavior separately audited | NONE |
| 23 | Railway #15 | `09b08767b3b7ba193b3b194cb7497f947f677f26` | feat(railway): activate volume-guarded SQLite production backend | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 24 | Railway #15 | `68cbd00f73c53f78c04c913ef4baa14d819f4817` | feat(railway): add private one-time SQLite Admin setup and canonical OAuth/Worker URLs | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 25 | Railway #15 | `854f6a7f0c9a2b3909bb827870a0e329c02ce474` | feat(railway): prepare one-app one-volume IaC and non-root SQLite runtime | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 26 | Railway #15 | `79edf20b0f70aa55423e4009d3f3cb2193345c1c` | fix(railway): close persistent SQLite session cleanup on shutdown | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 27 | Railway #15 | `a27a79c79e7b390f11350da6247936f4bf057fa1` | test(railway): verify isolated SQLite volume owner flow and restart persistence | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 28 | Railway #15 | `9a9e129913fb7657762bc4ae7258e4a99563bf75` | fix(railway): remove unnecessary async and diagnose CI formatting | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 29 | Railway #15 | `5649e5bce8fee4224e7c8ac325e798fcd1ae8ef3` | fix(railway): apply CI Prettier output and remove unused test binding | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 30 | Railway #15 | `9072d185c2f404c7aa8b32da4a580c97230c17a4` | fix(railway): return explicit HTTP 409 for duplicate first-owner setup | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 31 | Railway #15 | `ea20938d7a8fe09d21e3e00c078d6bbe38d6cd3d` | ci(railway): verify isolated Docker image and persistent SQLite mount without provisioning | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 32 | Railway #15 | `1fa2e6162181119b9f6a103eddc013db73a67c4e` | security(railway): fail closed on unsigned Worker installer downloads | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 33 | Railway #15 | `8b13cf6409c7d0e28686ff7ab7dba451df66061b` | fix(railway): report not-ready until canonical public HTTPS origin exists | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 34 | Railway #15 | `8d001ecc512a3ef5e9d54f746389efcd8c026950` | docs(railway): surface SQLite deployment guide and honest beta release gates | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 35 | Railway #15 | `101bfa1b16f9651ae25a91293461a153c7b87abd` | test(railway): exercise real SQLite Admin login and OAuth/PKCE consent grant | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 36 | Railway #15 | `ae3e4ac96e38c3485c0f2efb287e13f7eff64637` | test(railway): assert OAuth client secret and build Basic header without unsafe operands | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 37 | Railway #15 | `00999a55689381e887f34bee518932a8d30dd085` | test(railway): verify consistent online SQLite backup and disposable offline restore | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 38 | Railway #15 | `90e68efac810f9615aa391a07972dc1e907a8aae` | test(railway): enforce string URL serialization in PKCE E2E and collect exact test formatting | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 39 | Railway #15 | `d23941fa677c880cd52a58f9886778707db7ef30` | style(railway): apply CI-exact formatting for PKCE end-to-end and restore original quality gate | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 40 | Railway #15 | `e670e1df51d5d3ce2d60eb502989677d91dccfff` | feat(railway): record SQLite schema baseline and reject database symlink escapes | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 41 | Railway #15 | `37130b34028498dfa360554e9f80ce678cf1f60c` | security(railway): reject dangling SQLite symlinks as well as existing targets | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 42 | Railway #15 | `d5c08de9c8b982143350bdd4419af1e4fe98df7e` | test(railway): keep schema-version assertion formatted like existing SQLite checks | PORT — Railway increment incorporated selectively into finalized code tree | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 43 | Wave 2 PR25 | `10a95c511179ccda8fdd4f2378dd3c44841753e1` | docs(review): record T05 Railway task evidence, blockers and release acceptance matrix | EXCLUDED — historical T05 review docs remain in PR25 | NONE |
| 44 | Wave 2 PR25 | `d5ca654c8f64bab98167b7ed376aa1a2f0e0bb53` | review(T05): integrate verified T03 SQLite security hardening | PORT — accepted W2 Railway runtime/test or CI content | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 45 | Wave 2 PR25 | `e7de57a28f4894d302a6dfb24a577ea7b38b9a08` | docs(T05): record accepted T03 security and remaining integration blockers | EXCLUDED — historical T05 review docs remain in PR25 | NONE |
| 46 | Wave 2 PR25 | `c72900bac7c699847fcc11fe16877bec7e607f42` | feat(T05-W2): integrate verified signed Worker and real WSS/MCP E2E | PORT — accepted W2 Railway runtime/test or CI content | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 47 | Wave 2 PR25 | `0c3874dc537763a73d70590db15f2b283e265de9` | feat(T05-W2): integrate validated Railway SDK/IaC and disposable Docker tests | PORT — accepted W2 Railway runtime/test or CI content | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 48 | Wave 2 PR25 | `20e8c7b878a150309a967cc59cb839501eb172dd` | ci(T05-W2): require real Railway image/SDK gate on integration candidate | PORT — accepted W2 Railway runtime/test or CI content | `0dd535a88be4e1de605ece555e5b36d2e1fa4423` |
| 49 | Wave 2 PR25 | `65f1fb5c9b92836fbe5ad5d143585eeb054fb002` | security(T05-W2): integrate audited read-only PR ancestry release guard | PORT — read-only Git guard and safety tests | `f3cbe6b4bce3f32588be2ed840a9bb8a012e0a04` |
| 50 | Wave 2 PR25 | `1d617c9abfaaea8b9feae32da269124d5e3d8fd2` | docs(T05-W2): publish four-task integration review and no-go acceptance matrix | PARTIAL — migration history prose retained; historical acceptance not copied | `f3cbe6b4bce3f32588be2ed840a9bb8a012e0a04` |

**Classification warning:** The Vercel first two commits touched both portable shared contracts and Vercel-only functionality. The other Vercel commits are intentionally not replayed; some overlap shared files in the final tree, so content correctness is verified by independent source-tree review and tests, not by commit prefix or filename alone. SHA-to-SHA mappings aggregate selected content; they are **not** cherry-pick equivalence claims.

## Diff / ownership map

| Comparison | Changed paths | Scope |
|---|---:|---|
| TS6 → PR14: Vercel plus mixed Worker/auth | 87 | reference comparison |
| PR14 → PR15: 20 Railway incremental commits | 22 | reference comparison |
| TS6 → W2: complete stacked source | 117 | reference comparison |
| TS6 → W3: independent Railway + shared contracts | 91 | included in review |
| W2 → W3: intentionally removed/reworked sources | 45 | reference comparison |

**Vercel-only removed paths:** `api/index.ts`, `vercel.json`, `vercel-template.json`, `scripts/build-vercel.cjs`, `scripts/check-vercel-quickstart.mjs`, `src/config/managedStorage.ts`, `src/db/adapters/postgresAdapter.ts`, `src/db/upstashSessionStore.ts`, `src/services/distributedWorkerRelay.ts`, `src/routes/setupRoutes.ts`, `tests/vercel-distributed-worker.test.ts`, `tests/vercel-quickstart.test.ts`, `tests/vercel-template-core.test.ts`, `docs/VERCEL_QUICKSTART.md`, `docs/VERCEL_QUICKSTART_ACCEPTANCE.md`, `docs/VERCEL_SELFHOST_PREVIEW.md`. Also removed PostgreSQL/Upstash application dependencies and Vercel-only branches from server, broker, OAuth origin, session, database, setup, Docker/test CI. No Vercel-only original commit is an ancestor.

**Railway-only retained:** one-volume SQLite, owner setup, canonical Railway HTTPS origin, persistent sessions and hardening, review-only Docker/SDK/CI, offline signing tests and real Go WSS/MCP E2E tests.
**Shared security contracts selectively retained:** Worker-only authenticated WSS/socket freshness/capability checks, user/owner login and bcrypt, one-time CSRF setup, HKDF session/AES secrets, OAuth S256 PKCE, HTTP cookies, OAuth/Admin/Worker routes, explicit denial of unsigned installer and retired SSH transports. Original Postgres-only DB abstractions reverted to TS6 MySQL/SQLite where not needed.

## Exact blob parity W2 → W3 for selected Railway/security files

All 17 paths have matching Git blob SHAs at W2 source `1d617c9abfaaea8b9feae32da269124d5e3d8fd2` and candidate code `0dd535a88be4e1de605ece555e5b36d2e1fa4423`:
- `.railway/railway.ts` — `4b43ac485d7627bf722d4322e27ad0cde44c5e92`
- `.railway/validate.ts` — `b7c8064ab417a074b7e893ba3c642670652d4a17`
- `.railway/package-lock.json` — `e9bdf07e34e1ae4086276f8006adf8101c4e883f`
- `docker-entrypoint-railway.sh` — `7e001147e9ff095cef77acce9e0c5370c30ae3a0`
- `src/config/railwayOrigin.ts` — `97d0a6bfd1be0238637858787ba0b7dda15977ff`
- `src/routes/railwaySetupRoutes.ts` — `dec734565e6d64654eb34a9db2b3e3c3b4efeca1`
- `src/db/schema.sql` — `014af5d13bc470340441c103ad5ff8f8ecfd8496`
- `src/db/sessionStore.ts` — `860476514cdc5056ea096c847a0d038f08e05a57`
- `tests/railway-sqlite-quickstart.test.ts` — `9fa6b6600438a6bbdda6736e8bc0ff9ef3a1068c`
- `tests/railway-storage-security.test.ts` — `74b30bfe33a3cba878d1d2d1f0d9414da69cf760`
- `tests/railway-worker-wss-e2e.test.ts` — `ee31ad5c099e6c0f780660fa9c32bbe378628536`
- `tests/worker-signed-release.test.ts` — `e16c9e51b947a46a44109c7e6ca4677e38a37be0`
- `tests/railway-platform-config.test.ts` — `952e5b10036e761f618cd29652e8b584cbd98616`
- `tests/railway-platform-config-docker.test.ts` — `68889ed7047f1564667d099d0213e27f92e528f0`
- `.github/workflows/railway-worker-e2e.yml` — `e0cf219b533edd683d9fcae9dd96d6e3717ab240`
- `scripts/sign-worker-manifest.sh` — `608267acedfff103b02468925aa3b13d6052ec87`
- `scripts/test-linux-installer-lifecycle.cjs` — `1e4c177daeb8739204ae0b9ff86c6d65a9755353`

## Verification and unresolved gates

- Source refs directly checked: PR14 head `fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275`, PR15 head `d5c08de9c8b982143350bdd4419af1e4fe98df7e`, PR25 head `1d617c9abfaaea8b9feae32da269124d5e3d8fd2`. Git merge-base of all with TS6 is `2011a0745a36c625aa7f69de7a1b0a6c929313ee`. W3 code is a single TS6-parent commit.
- Strict local ancestry on W3 code: **PASS_INDEPENDENT (exit 0)**. Strict unchanged PR15: **BLOCKED_STACKED (exit 2)**. Guard also fails pinned SHA drift and empty candidates.
- Local TypeScript, build, lint, incremental quality gate: **PASS**. Node suite before guard-doc commit: **135 tests / 129 passed / 6 skipped / 0 failed**. Guard synthetic tests: **8/8 passed**. Skips are not live-security evidence.
- W2 baseline CI only (not W3 CI): https://github.com/mathew15064/mcp_worker/actions/runs/43336416296 ; Railway image https://github.com/mathew15064/mcp_worker/actions/runs/43336416409 ; Go WSS https://github.com/mathew15064/mcp_worker/actions/runs/43336416380 ; signed installer https://github.com/mathew15064/mcp_worker/actions/runs/43336416799 . Require fresh exact-W3-SHA CI before any approval.
- **HARD BLOCKER:** `.railway/railway.ts` is still review-only and pins OLD `e7de57a28f4894d302a6dfb24a577ea7b38b9a08` (stacked source). This task did not modify IaC owned by another task. A separately approved re-pin and linked Railway plan are required before independent deployment.
- **NOT VERIFIED:** live Railway HTTPS/WSS, approved public signing key/version, off-volume backup/restore, second-instance isolation, paid resources and production security acceptance. No billing resources or deployments authorized.
- PR14, PR15, PR25 remain Draft and untouched; do not merge or force-push. This candidate is solely a separate Draft review PR.

## Reproduce

    git rev-parse 0dd535a88be4e1de605ece555e5b36d2e1fa4423^
    git merge-base fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275 0dd535a88be4e1de605ece555e5b36d2e1fa4423
    git diff --name-status 1d617c9abfaaea8b9feae32da269124d5e3d8fd2 0dd535a88be4e1de605ece555e5b36d2e1fa4423
    node scripts/check-railway-pr-stack.mjs --base origin/refactor/typescript-ts6 --vercel origin/feature/vercel-selfhost-20261112 --railway HEAD --expect-base-sha 2011a0745a36c625aa7f69de7a1b0a6c929313ee --expect-vercel-sha fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275 --expect-railway-sha "$(git rev-parse HEAD)" --json --strict
