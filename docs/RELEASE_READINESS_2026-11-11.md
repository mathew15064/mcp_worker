# TS6.3 public release readiness evidence — 2026-11-11

**Candidate commit:** `94ec834ac6a9c6f4a6f41e63c33b9f9d92c829ec`.
This report records technical evidence on the candidate **before** this
documentation update. It is **not** independent security certification,
owner approval, or authorization to publish/tag/merge.

## Verified technical evidence

- GitHub [CI](https://github.com/mathew15064/mcp_worker/actions/runs/42989467358) and
  [isolated Docker release verification including SBOM and vulnerability gate](https://github.com/mathew15064/mcp_worker/actions/runs/42989467214)
  completed successfully for the candidate source head.
- Clean Linux Docker release verification was rerun outside CI: fresh install,
  MySQL 13 migrations, actual Admin login, persisted user/Worker/OAuth identity
  after full Compose stop/start, 19 MCP tools, unauthenticated rejection,
  eight Worker binary checksum checks, real outbound Linux Worker E2E and
  regression tests: **101 passed, 0 failed, 0 skipped**.
- Dedicated **internal-only** staging was created with private MySQL/app
  volumes; the app and database were healthy, and `/healthz` and `/readyz`
  returned HTTP 200 on a loopback-bound test port. Its image's OCI commit
  label matched the candidate. It is not a public endpoint.
- A disposable **test-only RSA keypair** signed the built Worker
  `SHA256SUMS` via `scripts/sign-worker-manifest.sh`. Verification with the
  paired public key passed and verification after modifying the manifest
  correctly failed. The ephemeral keys and test files were removed; no
  release signing key was created, published or approved.
- Gitleaks **v8.30.1** scanned **46 reachable Git commits** (about **2.11 MB**)
  at the candidate head with its default rules, reporting **17**
  `generic-api-key` matches. All 17 were manually triaged as
  **64-character hex SHA-256 digest values** in historical
  `quality/baseline.json` file-fingerprint mappings (file path to digest,
  one commit). No confirmed credential was identified in those findings.
  The detailed redacted scanner report is held locally, outside Git.
  This is not an independent scan of all PII or infrastructure references.
- The committed lockfile was checked: **262 npm packages**, including
  **156 runtime/non-dev** and **106 dev-only** entries, all with registry URL
  and integrity metadata. See the separate [third-party review](THIRD_PARTY_DEPENDENCIES.md)
  and [candidate runtime inventory](THIRD_PARTY_RUNTIME_INVENTORY.md).

## Inconclusive or missing gates

- A supplemental **local Trivy rescan** failed because downloading the
  vulnerability database was interrupted by a network connection reset.
  It cannot be marked PASS. The separate GitHub Actions scan for the
  candidate passed, but must be repeated on the *final* publishable artifacts.
- Independent architecture/security review, a complete secret/history/PII
  audit and owner-approved sanitized export remain outstanding.
- Complete license/attribution texts for distributed image/binaries and
  MySQL derivative obligations need owner/legal approval.
- Native **Linux user-mode** manual installer lifecycle passed a local
  non-privileged, disposable-home test (fresh install; unchanged reinstall;
  valid ephemeral-key RSA signature; rejection of invalid/missing signatures;
  tampered checksum rejection; distinct binary fixture upgrade; rollback;
  refusal of manual update/uninstall on a systemd-managed identity; ordinary
  uninstall). It is integrated into the isolated release verification script.
  Signing keys were **test-only**; these tests do **not** validate an actual
  systemd-managed upgrade/recovery/uninstall, macOS/Windows, or public
  release signing/key distribution.
- Native macOS/Windows installer install/upgrade/rollback/uninstall and
  Linux systemd recovery/uninstall checks are still outstanding.
- Public HTTPS reverse-proxy, remote Worker WSS and real MCP OAuth client
  E2E are still unverified. Internal loopback staging is not a substitute.
- Owner-approved private vulnerability disclosure channel, signing key
  custody/public-key distribution, final artifact provenance, backups,
  rollback plan and release approval remain outstanding.

## Decision

**NOT READY for a public stable release.** No production VPS changes,
release tag, signed public artifacts, GitHub Release or PR merge were
performed during this review. The existing production service is a
different-generation Bot Report V3 installation and must not be replaced
by the V2 TypeScript candidate without an explicitly approved migration
and rollback plan. See [release checklist](RELEASE_CHECKLIST.md).
