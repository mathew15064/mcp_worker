# Standalone mcp_worker — local development / release gate

**Status: PRIVATE DEVELOPMENT; PUBLIC RELEASE NO_GO.** This change is not permission to tag, publish, enable `/worker/install*`, embed a trust key, or distribute binaries.

## Development CLI

On a PC with Go 1.24+, run `./scripts/build-standalone-cli.sh`. The resulting ignored `worker/dev-bin/mcp_worker` is an **unsigned development binary**, not a public installer.

- `mcp_worker --help`, `mcp_worker version`: offline, before configuration.
- `mcp_worker setup --server https://<trusted-server>`: prompt for one-time enrollment token (do not pass tokens on a shell command line).
- `mcp_worker config show`: local redacted public settings only.
- `mcp_worker connection test`: tests HTTP(S) `/healthz` and `/readyz`, **not** proof of authenticated WSS/online Worker.
- `mcp_worker re-enroll --confirm --server https://<another-trusted-server>`: the Worker must be stopped and unmanaged. It creates a new identity and stores the previous `config.json` and `state.json` in a mode-0700 backup directory under `~/.worker_mcp`. An enrollment failure does not replace the prior identity; old identity must be revoked in Admin once migration succeeds.

`worker_mcp` CLI remains compatible with existing local integrations. The signed platform installers also expose the user-facing `mcp_worker` alias (or `mcp_worker.exe` on Windows). One installation connects to one server; no automatic server switching.

For owner-reviewed updates on a stopped, unmanaged Linux/macOS Worker, invoke `mcp_worker update --version X.Y.Z --commit <40-character-sha> --manifest-sha256 <64-character-sha256>`. All three values must be independently approved. The CLI authenticates the canonical nine-file manifest against the locally stored public RSA key and SPKI fingerprint from the previous signed installation, checks the detached signature, target commit, metadata and platform binary identity, then performs an atomic executable replacement. It retains the prior executable for operational recovery and rejects same-version reinstall, downgrade or unapproved key substitution. The Worker remains stopped until manually started. Windows or managed Linux services instead require the separately reviewed platform signed installer; no in-process replacement of a running Windows executable is attempted.

The upgrade CLI has no configurable release origin: it requests the exact pinned version from GitHub Releases over HTTPS. There is no unauthenticated `latest` upgrade, HTTP downgrade, or automatic rotation of the signing trust root.

## GitHub-first private RC templates

Run `npm run build && node scripts/render-worker-github-rc.cjs` on the development PC. Generated files under ignored `worker/dev-bin/github-rc/` are **fail-closed templates with empty approval pins**. They reference the repository's release-asset path, not MCP Server distribution. They cannot install without owner-reviewed, source-pinned release metadata and a valid detached RSA signature; no private signing key is generated or stored.

Existing eight `worker_mcp-<os>-<arch>` artifact names, nine-entry canonical manifest, detached signature verification, key fingerprint pinning, semver anti-downgrade and automatic binary rollback are reused from `src/routes/workerRoutes.ts`. The GitHub renderer is *not* exposed on a public route. GitHub asset redirects are permitted only over HTTPS and all downloaded bytes are verified against owner-pinned signed checksums. Legacy server-installer redirects remain prohibited.

Before a future release, complete owner signing outside this repo and record the exact version, 40-character commit, approved public key + SPKI digest, all 9 artifact digests, detached signature, HTTPS origin and native Linux/macOS/Windows lifecycle evidence. Keep `workerDistributionBlocked()=true` until **separate** owner approval. Manual downgrade remains prohibited; automatic restoration is only for a failed replacement.

## QA status

PC results (2026-11-17): Go unit tests PASS including disposable RSA-signed update, forged signature, tampered metadata/binary, downgrade and failed-upgrade binary recovery; Node 164 PASS / 0 FAIL / 1 SKIP; Playwright Chromium 16/16 PASS; TypeScript lint/typecheck PASS; 8/8 native-target Go cross-build PASS. On a real Windows PC, PowerShell installer syntax check, unsigned-release fail-closed, and compiled Windows amd64 CLI help/version/config-show smoke all PASS. These are NOT native signed-install or upgrade lifecycle acceptance. Native Windows signed installer lifecycle: NOT_TESTED; native macOS signed installer lifecycle: NOT_TESTED; multi-platform owner-signed release acceptance: NOT_TESTED. Public release remains NO_GO. The Server deployment and its SQLite volume must not be changed for this work.
