# T5 — Dependency security review (Local PC, 2026-11-13)

**Status: REVIEW REQUIRED; not a clean security scan and not a deploy approval.** Read-only checks were run from the isolated `work/oneclick-unblock-t5` worktree via Bot Report 2 profile `PC`, Node 22.22.3/npm 10.9.8. No lockfile, dependencies, production service, registry or cloud resource were modified.

## Measured results

| Command (Local PC only) | Informational | Low | Moderate | High | Critical |
| --- | ---: | ---: | ---: | ---: | ---: |
| `npm audit --json` | 0 | 0 | **11** | 0 | 0 |
| `npm audit --omit=dev --json` | 0 | 0 | **2** | 0 | 0 |

**Runtime/prod dependency chain (verified with `npm ls --omit=dev`):** `@modelcontextprotocol/sdk@1.32.2` → `@hono/node-server@2.1.5` → `hono@4.13.14`, and the SDK directly depends on `hono`. Neither package is directly declared by this app, so upgrades must respect the SDK's compatibility range and retest OAuth/MCP transport.

- `@hono/node-server` below 2.1.6: `GHSA-qv5m-9pm6-hqp3` (unhandled ECONNRESET during async WebSocket upgrade) and `GHSA-jpvv-r467-5p4w` (reverse-proxy path normalization).
- `hono` at or below 4.13.15: `GHSA-4m76-xfj5-7975`, `GHSA-h7mg-cq63-vhpq`, `GHSA-3gg2-335m-rxc6`, `GHSA-46wx-v44x-9hh2`, `GHSA-4h7h-rv7c-7m2v` (mount/middleware path, RegExpRouter, CSS, CSRF ping, form validation issues). The advisory feed reports patched `hono >=4.13.16`; actual compatible resolution must be verified in a separate authorized dependency change.
- The remaining nine moderate nodes in the **full** tree include `eslint`, `typescript-eslint`, `@typescript-eslint/*`, `@eslint/config-array` and `minimatch`. These are reported in development tooling, not the `--omit=dev` runtime set. The auditor reports some suggested fixes as SemVer-major / version downgrades; do **not** run `npm audit fix --force` blindly.

## Safe remediation plan for a separate approved integration change

1. Freeze the exact final source + `package-lock.json`; confirm the full SDK and its supported semver ranges. Investigate `npm ls hono @hono/node-server --all --omit=dev` and published patch versions on the owner's PC.
2. In a new *separate, isolated* PC worktree and reviewable lockfile commit, prefer compatible `@hono/node-server >=2.1.6` and `hono >=4.13.16`, or a fixed `@modelcontextprotocol/sdk` update. Avoid forcing vulnerable older or incompatible versions. Neither T5 nor other parallel workers own this shared lockfile.
3. Re-run `npm ci`, `npm audit --omit=dev`, `npm run typecheck`, `npm run lint:typed`, `npm test`, `npm run test:e2e`, WSS/OAuth/PKCE and Docker tests **entirely on PC**, then inspect production-image dependency tree and manifest. Verify API/path/header behavior behind the actual HTTPS reverse proxy only in the later owner-approved private pilot.
4. Separately review nine development-tooling findings. Do not reduce test coverage, disable ESLint or assume an audit report is an exploit proof; track severity, context, reachable paths and upstream fixes. Record any remaining advisory as a release risk requiring owner approval.

**Interpretation:** advisories describe potentially affected versions; this audit does not establish that the application exercises each vulnerable path. Conversely, local tests do not prove the paths are unreachable. The two production advisories must be reviewed before public One-Click publication. There are no approved changes to the lockfile in this T5 task.

## Provenance and boundaries

- Source predecessor: `f1ac7d3651ccdb01f1f4acc44a8072a48b188205` cherry-picked onto base `ae588a1a56f2561ca2323457463e5b9e203de509`.
- Executed `npm ci --no-audit --no-fund`, `npm audit --json`, `npm audit --omit=dev --json` and `npm ls hono @hono/node-server --all --omit=dev` on PC only.
- `npm audit` exited nonzero due to actual advisories. The shell captured its JSON for summary; this **does not mean the audit gate passed**.
- No Github Actions, remote builds, deployment, registry upload, CI/CD, production secrets or paid Railway resources used.

## Integration follow-up — production advisory remediation (Local PC, 2026-11-13)

In the separately authorized **local final integration worktree** (not in the isolated T5 worker), the reviewer executed `npm update hono @hono/node-server --package-lock-only --ignore-scripts --no-audit --no-fund`. Only `package-lock.json` changed (12 lines); the root `package.json` and `@modelcontextprotocol/sdk@1.32.2` were unchanged. npm resolved compatible patches `hono@4.13.18` and `@hono/node-server@2.1.8` inside the SDK's declared ranges.

After a clean PC `npm ci --no-audit --no-fund`, **`npm audit --omit=dev` returned exit 0, 0 known production advisories**. The complete `npm audit` still reports **9 moderate development-tooling advisories**, exit 1; no automated major-version downgrade/force-fix was applied. The remaining development issues are a recorded review item, not a production-security-green claim. Full integrated regression tests and the final PC Docker build must be rerun on the committed source with this lockfile; real Railway reverse-proxy and ChatGPT connectivity remain NOT_TESTED. This local dependency fix is not owner approval for public release.
