# Railway PR #15 stack migration — W3 independent candidate

**W3-T01 outcome (2026-11-13): independent history built for review, NOT release approval.** The new branch `feat/railway-p15-w3-t01-independent-history` forks the approved TS6 commit `2011a0745a36c625aa7f69de7a1b0a6c929313ee`, rather than PR #14 or PR #15. The immutable integration source snapshot is `1d617c9abfaaea8b9feae32da269124d5e3d8fd2` (Draft PR #25). The first independent portable-code commit is `0dd535a88be4e1de605ece555e5b36d2e1fa4423`. The exact source-to-candidate commit map is in [RAILWAY_SOURCE_PROVENANCE.md](RAILWAY_SOURCE_PROVENANCE.md).

## Executed W3 separation

- The original topology remains **TS6 → 22 Vercel commits (PR #14) → 20 Railway commits (PR #15) → 8 Wave 2 commits (PR #25)**. PR #15 is still `BLOCKED_STACKED`; no existing PR branch was rewritten, retargeted or merged.
- The W3 code commit has only the TS6 parent, so the Vercel PR #14 head is **not** an ancestor. This carries the required *content* of selected shared Worker/auth contracts without carrying the Vercel *commit ancestry*. The strict guard also refuses an empty TS6 candidate and stale pinned source SHAs.
- **Vercel-only excluded:** `api/index.ts`, `vercel.json`, `vercel-template.json`, Vercel docs/tests/build/probe, Neon/PostgreSQL adapter, Upstash store and managedStorage, distributed Redis Worker relay, and production dependencies `pg` / `@upstash/redis`. Removed Vercel branches in `src/app.ts`, databaseManager, sessions, issuer, origin, admin auth, broker, release smoke and CI. No Vercel Function or Redis cross-instance execution path remains in the Railway code tree.
- **Shared portable contracts retained:** outbound authenticated Worker WSS with reconnect/socket freshness and capability enforcement; owner/OAuth identity and PKCE; CSRF/session/cookie protections; secret derivation, bcrypt and AES-GCM; Worker-only SSH retirement; auth/migration/schema compatibility. These originate in part from Vercel-era commits and must be reviewed as explicit content ports, **not** omitted merely because of their source branch.
- **Railway-specific content retained:** volume-guarded SQLite, schema version and integrity checks, symlink rejection, one-time Admin setup, canonical HTTPS issuer, persistent sessions, Docker/SDK review-only configuration, non-root container entrypoint, offline signed installer verification, real Go WSS/MCP E2E tests and SQLite backup/restore tests.
- The historical W2-T05 `docs/RAILWAY_INTEGRATION_REVIEW.md` and `docs/RAILWAY_ACCEPTANCE.md` stay on [Draft PR #25](https://github.com/mathew15064/mcp_worker/pull/25), rather than being imported into an independent candidate as if current approval artifacts.

**Important remaining dependency:** `.railway/railway.ts` still pins the historical *review-only* `e7de57a28f4894d302a6dfb24a577ea7b38b9a08` source. Per T02 ownership, W3 did **not** repin, apply or publish this IaC. The template cannot be applied as an independent Railway release until a separately approved authoring task reviews and pins the final tested independent commit. Live Railway HTTPS/WSS, billable resource approval, public signing trust root, off-volume recovery and independent-instance isolation also remain **BLOCKED/UNTESTED**. Ancestry PASS is not permission to merge, provision or deploy.

## Read-only strict checks

```sh
node scripts/check-railway-pr-stack.mjs --base origin/refactor/typescript-ts6 \
  --vercel origin/feature/vercel-selfhost-20261112 --railway HEAD \
  --expect-base-sha 2011a0745a36c625aa7f69de7a1b0a6c929313ee \
  --expect-vercel-sha fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275 \
  --expect-railway-sha "$(git rev-parse HEAD)" --json --strict

node scripts/check-railway-pr-stack.mjs --base origin/refactor/typescript-ts6 \
  --vercel origin/feature/vercel-selfhost-20261112 \
  --railway origin/feature/railway-sqlite-oneclick-20261112 \
  --expect-railway-sha d5c08de9c8b982143350bdd4419af1e4fe98df7e --json --strict
# Expected: first PASS_INDEPENDENT/exit 0; second BLOCKED_STACKED/exit 2.
```

---

## Historical Wave 2 planning (retained for audit)

# Railway PR #15 stack migration decision — W2-T04

**Decision: BLOCKED / plan only (2026-11-12).** Do not merge, retarget PRs, deploy, provision Railway, sign binaries, rewrite Git history or interpret this document as a release authorization. PRs #14, #15, #19 remain Draft.

## GitHub-verified topology

Evidence from the GitHub compare endpoint and PR metadata:

| Relation | Ahead / behind | Merge-base | Changed paths |
|---|---|---|---:|
| [TS6 → PR #14](https://github.com/mathew15064/mcp_worker/compare/2011a0745a36c625aa7f69de7a1b0a6c929313ee...fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275) | +22 / -0 | 2011a0745a36c625aa7f69de7a1b0a6c929313ee | 87 |
| [TS6 → PR #15](https://github.com/mathew15064/mcp_worker/compare/2011a0745a36c625aa7f69de7a1b0a6c929313ee...d5c08de9c8b982143350bdd4419af1e4fe98df7e) | +42 / -0 | same TS6 SHA | 99 |
| [PR #14 → PR #15](https://github.com/mathew15064/mcp_worker/compare/fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275...d5c08de9c8b982143350bdd4419af1e4fe98df7e) | +20 / -0 | fd99667a3dfbdf4ccdf9ccda4b612f819dd1e275 | 22 |

    TS6 base (2011a074)
            |
    +22 commits: Vercel #14 (fd99667a)
            |
    +20 commits: Railway #15 (d5c08de)

PR #14 and #15 target the same TS6 branch; both are Draft and unmerged. PR #15 is a **true descendant** of PR #14, not simply similar code. Directly merging PR #15 into TS6 necessarily imports the 22 upstream commits and their Vercel/Worker/auth changes.

[Review PR #19](https://github.com/mathew15064/mcp_worker/pull/19) is a separate Draft candidate, head e7de57a28f4894d302a6dfb24a577ea7b38b9a08, based on the Railway feature branch; it contains reviewed T03 hardening and T05 documents, **not** all T01/T02/T04 implementations. W2-T04 forks that SHA, without modifying PR #19.

### Commit map

| Slice | First → last commit | Content |
|---|---|---|
| Vercel original 22 | ca16b7db7f → fd99667a3d | Function/Neon/Upstash, shared setup/auth/Worker relay and retirement of SSH, Vercel tests/workflows |
| Railway commits 1–5 | 09b08767b3 → a27a79c79e | SQLite volume, one-owner setup, canonical origin, one-service container, persistence |
| Railway commits 6–12 | 9a9e129913 → 8d001ecc51 | formatting, duplicate owner 409, Docker CI, unsigned Worker fail-closed, readiness and docs |
| Railway commits 13–20 | 101bfa1b16 → d5c08de9c8 | OAuth/PKCE and backup tests, schema version, symlink hardening |

All 20 Railway incremental commit prefixes in sequence (pin the full SHAs before any future application):
09b08767, 68cbd00f, 854f6a7f, 79edf20b, a27a79c7, 9a9e1299, 5649e5bc, 9072d185, ea20938d, 1fa2e616, 8b13cf64, 8d001ecc, 101bfa1b, ae3e4ac9, 00999a55, 90e68efa, d23941fa, e670e1df, 37130b34, d5c08de9.
Canonical complete histories are at the three compare links above.

### Overlap and ownership classification

Of 99 paths in PR #15's aggregate TS6 diff, **87 also appear in PR #14**, with **12 newly introduced paths**. Railway's 22 incremental changed paths include **10 also touched by Vercel** and 12 new paths. Path overlap is not semantic equivalence.

| Class | Representative paths | Risks |
|---|---|---|
| Vercel-only | api/index.ts; vercel.json; vercel-template.json; scripts/build-vercel.cjs; src/db/adapters/postgresAdapter.ts; src/db/upstashSessionStore.ts; src/services/distributedWorkerRelay.ts; Vercel docs/tests | Neon/Upstash and Function relay should not enter a Railway-only release without explicit approval |
| Shared auth/OAuth/Worker | src/app.ts; src/config/{env,mcpConfig,managedStorage}.ts; src/routes/{setupRoutes,workerRoutes}.ts; src/middleware/sessionMiddleware.ts; src/services/{adminIdentityService,applicationKeyService,runtimeSettingsService,workerConnectionBroker}.ts; src/db/databaseManager.ts | Railway relies on some shared foundations originally modified by Vercel; isolation requires deliberate ports and security regression tests |
| Railway-only | .railway/*; Dockerfile.railway; docker-entrypoint-railway.sh; docs/RAILWAY_QUICKSTART.md; src/config/railwayOrigin.ts; src/routes/railwaySetupRoutes.ts; src/db/{schema.sql,sessionStore.ts}; tests/railway-sqlite-quickstart.test.ts | Persistent volume, SQLite, owner claim, OAuth issuer, one replica, restart and shutdown |
| Migration/build/release | .github/workflows/{test,worker-artifact-build,railway-sqlite-preview}.yml; package.json; package-lock.json; Dockerfile; src/db/{migrationRunner,schemaBuilder}.ts; src/db/migrations/*; scripts/release-verify.sh; quality/baseline.json; tsconfig.json | Shared migration and signed-artifact contracts are cross-platform; must be explicitly reviewed |

These are **concern categories, not mutually exclusive commits**. Do not separate by path prefix alone. Especially audit the ten Railway-incremental files that Vercel already touched, including src/app.ts, configuration, database manager, session middleware and owner/key services.

## Option A — deliberate stack; approve Vercel first

**Conditions:** Only consider when the owner **wants Vercel as a Railway dependency**, and Vercel security/release gates, shared auth/Worker behavior and costs are explicitly approved.

1. Pin TS6, PR #14 and PR #15 head SHAs, complete diff, merge-bases, file list and CI snapshots. Stop if any SHA moves.
2. Complete Vercel #14 review and acceptance. Under **separate future authorization**, merge #14 first; do not change original history here.
3. Re-evaluate #15 relative to the newly approved base, accounting for GitHub merge method (merge/squash affects ancestry). Confirm the residual Railway scope matches the intended 20-commit increment and includes no unreviewed upstream Vercel changes.
4. Run full integration CI, signed Worker verification, SQLite backup/restore, OAuth/PKCE, WSS/Worker tests, two-instance isolation and live Railway acceptance.
5. Obtain separate explicit approvals for security, Railway costs, merge and release.

**Risks:** Prematurely imports Neon/Upstash/Function code and shared Worker/auth changes; contracts may differ across platforms; upstream/base drift may invalidate review; squash merges change SHAs.

**Verify:** Compare exact SHAs; inspect residual diff and git range-diff, migrations and shared changes; full CI and live gates must pass. No production-ready claim from offline tests.

**Rollback:** Prior to merge, leave Draft PRs untouched. Following any separately authorized merge, use reviewed revert PRs (not forced history rewrites), last-known-good artifact and independently tested off-volume SQLite restore. Schema rollback requires a separately reviewed forward-compatible recovery plan.

**Pre-merge:** PR #14 approved and already merged in proper order; residual #15 re-reviewed; all gates green; cost and release owner sign-off.

## Option B — independent Railway patch series (recommended)

**Conditions:** Prefer when Railway is meant to ship without Vercel-specific runtime/dependency stack. This is a **future migration plan**, not a command executed by W2-T04.

1. Owner approves/pins a target base SHA and the shared setup/auth/Worker contracts that should be portable. Archive all 42 source commits, patches and tests before changes.
2. On a *new future candidate branch*, apply an audited Railway patch series derived from the 20 incremental commits, with explicit ports of required upstream shared contracts. Maintain a full source-SHA → candidate-SHA ledger. Do not blindly cherry-pick all commits or exclude Vercel files by filename.
3. Review every patch, deletions, merge conflict and dependency import. Compare candidate behavior with #15's incremental diff using git range-diff, file diff, schema/CSRF/session and Worker contract tests.
4. Verify candidate base ancestry and absence of the Vercel-only head history via the guard in strict mode. Independent ancestry **alone** is not semantic or release acceptance.
5. Integrate T01 signed Worker, T02 Railway volume/template, T03 SQLite security and T04 real WSS E2E on an approved candidate. Test offline and live evidence. Open a *separate* future review PR; keep #14/#15 Draft and unchanged pending explicit decision.

**Risks:** Missing upstream shared security behavior, duplicate authentication logic, schema incompatibility, test coverage gaps or lossy conflict resolutions. A port of Vercel-origin shared behavior is not “Vercel-only ancestry”, but needs explicit review.

**Verify:** Commit provenance ledger and patch equivalence; no inherited Vercel ancestry, full CI, signing fail-closed, SQLite restart/restore, OAuth/PKCE, actual Go Worker WSS, two independent Railway deployments and cost approval.

**Rollback:** Before merge, discard the future candidate without touching #14/#15; reapply audited source patches as needed. After authorized merge, reviewed revert/roll-forward and tested off-volume backup recovery; never force-push protected branches.

**Pre-merge:** Approved independent base, documented portable contracts, no inherited upstream Vercel history, complete integration verification, live production acceptance and sign-offs.

**Recommendation:** Option B, unless the owner explicitly approves the Vercel dependency and accepts Option A's upstream surface. Do not choose a merge order until these conditions are met.

## Local read-only guard

Run with *already locally available* refs:

    node scripts/check-railway-pr-stack.mjs --help
    node scripts/check-railway-pr-stack.mjs \
      --base origin/refactor/typescript-ts6 \
      --vercel origin/feature/vercel-selfhost-20261112 \
      --railway origin/feature/railway-sqlite-oneclick-20261112 \
      --json --strict

The script **never fetches, checks out, merges, rebases, updates Git refs, deploys or provisions**. Operators must separately fetch/refresh and confirm exact GitHub head SHAs. Exit code 0 with PASS_INDEPENDENT means *ancestry safe to review*, **not** release approval. BLOCKED_STACKED and other BLOCKED_* statuses exit 2 with --strict; invalid/missing refs exit 64. Rerun on any SHA movement.

See [Release gates](RAILWAY_RELEASE_GATES.md). T05-owned RAILWAY_INTEGRATION_REVIEW.md and RAILWAY_ACCEPTANCE.md are untouched.
