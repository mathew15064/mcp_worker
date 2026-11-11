# V2 publication checklist

This is a gate checklist, not an authorization to publish.

- [x] Local source cleanup and preliminary dependency provenance review.
- [x] Standalone fresh install, persistence, read-only OAuth/PKCE onboarding.
- [x] Real Linux Worker: all 19 tools, upgrade, rollback, signature rejection.
- [x] Local release verification: 101/101 TS6.3 regression (2026-11-11);
  eight Worker cross-build checksums.
- [x] Local Chromium Admin UI suite (12 tests, P8.3).
- [x] Cold backup/restore drill into a separate project: original volumes
  retained, encrypted bootstrap, user/Worker records, OAuth and MCP verified.
- [x] P8.5.1 image scan: zero HIGH/CRITICAL findings for tested app/MySQL
  images using Trivy 0.76.2, DB updated 2026-11-10 19:01 UTC.
- [ ] Repeat verification and scan against the final release commit/artifacts.
- [ ] Independent secret/history/PII scan and owner-approved sanitized export.
- [x] Owner-provided MIT LICENSE retained in new repository.
- [ ] Third-party notices and corresponding-source
  obligations for distributed MySQL derivative and other dependencies.
- [ ] Private security reporting channel approved by owner.
- [ ] Native macOS/Windows installer upgrade/rollback/uninstall tests.
- [ ] Explicit systemd upgrade/recovery/uninstall validation.
- [ ] External HTTPS reverse proxy and remote MCP client end-to-end verification.
- [ ] Actual CI run on approved repository; inspect artifacts and scan gates.
- [ ] Owner-approved signing key/public-key distribution and signed artifacts.
- [ ] Release tag, image identity/provenance, rollback and backup evidence,
  owner approval to publish.

## TS6.3 candidate evidence (2026-11-11)

For the tested source head `94ec834`, the [GitHub CI](https://github.com/mathew15064/mcp_worker/actions/runs/42989467358)
and [release-verification](https://github.com/mathew15064/mcp_worker/actions/runs/42989467214)
workflows passed. A local clean-checkout rerun passed 101/101 regression
tests, and temporary-key signature verification correctly rejected a
tampered manifest. Gitleaks found only triaged SHA-256 quality-baseline
fingerprints in its 46-commit history scan. See
[the dated readiness audit](RELEASE_READINESS_2026-11-11.md).

These are **candidate** results, not final artifact/owner approval. An extra
local Trivy attempt failed while downloading its database; do not mark that
separate attempt PASS. External HTTPS, installer lifecycle, licensing, signing
key custody and independent audits remain open.

The public source repository is not a stable release; no release tag, signing
key or production deployment is implied by this checklist. Keep production
untouched. Scan findings are time-dependent; re-run before release and on
base/dependency changes.
