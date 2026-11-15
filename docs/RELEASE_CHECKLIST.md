# V2 release checklist — current PC candidate

**Decision: NO_GO / review required.** This checklist does not authorize a tag,
commit, signing root, image publication, Railway operation, CI, production
credential use, or acceptance of outside OAuth clients. Main reviewer alone
assigns a task PASS; the product owner alone may authorize release.

## Consolidated PC verification (2026-11-15, pre-freeze)

- Node 183 PASS, 0 FAIL, 10 environment SKIP; disposable MySQL 5/5; localhost OAuth/WSS/Go Worker 3/3; Chromium 16/16; Go 1.24 unit/race/vet; Node typecheck/lint/format/build PASS.
- npm audit production: zero vulnerabilities; all-dependency audit: nine moderate dev-tool advisories, zero high/critical. Preliminary source secret-pattern scan found no matches; independent PII/history review remains pending.
- Exact committed-source OCI builds, approved production Worker signing, external ChatGPT HTTPS connection and offsite recovery remain release gates. Repository-level GitHub Actions disablement has not been verified: no remote push.

## Earlier T5 independent execution (2026-11-14, historical)

- RUN: `RUN-MCPW-V200-FULLDEV5-20261114T130527Z-33d23fe27be9`;
  Task T5, snapshot version 1; PC-only checkout
  `/root/mcpw_w2_t5_20261114`.
- HEAD: `48473a309b6f832a44265249ab7227c0d45c62c3`;
  TREE: `522e12c5347b4d8d6880e20d421b98127e855fbb`.
  The worktree is **dirty by design** (an earlier T5 browser SKIP fix plus
  this local QA patch), so there is **no committed release artifact** and
  no exact clean-source OCI provenance claim. Other workers have separate
  unintegrated changes.
- PASS locally: Node 22 quality/typecheck/build; SQLite/OAuth quickstart
  fixture; signed-release unit tests; native Linux test-only signed
  installer lifecycle (canonical 9-entry manifest, complete 40-hex
  version identities, independent pinned RSA SPKI, negative signature,
  checksum, mismatched key, rollback/upgrade, and uninstall); Go 1.24
  unit/race/vet, real loopback WSS, two-worker isolation; Chromium
  Playwright suite (15/15). No production signing or external network
  used to generate these fixtures.
- Mandatory **NOT_TESTED**: disposable local MySQL suites; current
  complete clean-source standalone/Railway OCI builds and container
  volume verification; fresh npm audit; CycloneDX/Trivy scans and DB freshness;
  macOS/Windows native installers; privileged systemd operations; real
  Railway/HTTPS/ChatGPT connection; independent off-platform restore.
  An ordinary root-run recovery suite also emitted a machine-counted
  permission-dependent TAP SKIP. Treat as missing mandatory coverage.
- `bash scripts/local-verify-quickstart.sh --targeted` is the
  small-change smoke. `T5_BROWSER_SANDBOX=1 bash
  scripts/local-verify-quickstart.sh --full` executes what is locally
  available, records per-gate exit/skip/NOT_TESTED, and exits **3** when
  mandatory coverage is missing. See
  [RELEASE_ENGINEERING.md](RELEASE_ENGINEERING.md) for exact prerequisites.

## Owner/reviewer acceptance list

- [ ] Main integrates T1–T5 without losing any prior dirty patches; review
      exact final source commit/tree, lockfile, signed gate and tests.
- [ ] All mandatory Node, browser, SQLite, MySQL, Go/WSS, native platform,
      Docker/OCI, recovery and security gates recorded PASS without skips.
- [ ] Independent owner-approved private signing key, SPKI pin, manifest
      signatures and all eight native platform Worker artifacts.
- [ ] Fresh, authorized dependency audit, SBOM and scanner DB / vulnerability
      review on final immutable app **and** MySQL image identities.
- [ ] License/third-party notices and MySQL derivative source obligations.
- [ ] Approved public security reporting channel and sanitization/history
      audit; systemd recovery and rollback/backup simulations.
- [ ] Off-platform encrypted restore to independent empty resources with
      approved retention, recovery operator and measurable RPO/RTO.
- [ ] Owner-confirmed billing, exact OCI registry manifest digest, private
      image source, one Railway service/SQLite volume/replica, HTTPS origin
      and actual external read-only ChatGPT OAuth/MCP pilot.
- [ ] Separate approval for merge, production signing, CI, tag, publish,
      remote deployment and public template. Until then Worker download
      returns HTTP 503 `WORKER_SIGNED_RELEASE_PENDING`.

## Historical evidence only — NOT this run

For the old `94ec834` candidate (2026-11-11), historical
[GitHub CI](https://github.com/mathew15064/mcp_worker/actions/runs/42989467358)
and [release verification](https://github.com/mathew15064/mcp_worker/actions/runs/42989467214)
reported green, alongside a 101/101 local regression, a 12-test
Chromium run and a dated Trivy 0.76.2 scan for **different images**
(DB dated 2026-11-10). A separate Trivy attempt failed to fetch its DB.
Those results are not evidence for this T5 worktree, the final integrated
source, a new SBOM, a current vulnerability database, or authorization
to run GitHub Actions. See [dated audit](RELEASE_READINESS_2026-11-11.md).
