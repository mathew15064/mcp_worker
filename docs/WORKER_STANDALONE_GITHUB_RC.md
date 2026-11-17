# Standalone mcp_worker — local development / release gate

**Status: PRIVATE DEVELOPMENT; PUBLIC RELEASE NO_GO.** This change is not permission to tag, publish, enable `/worker/install*`, embed a trust key, or distribute binaries.

## Development CLI

On a PC with Go 1.24+, run `./scripts/build-standalone-cli.sh`. The resulting ignored `worker/dev-bin/mcp_worker` is an **unsigned development binary**, not a public installer.

- `mcp_worker --help`, `mcp_worker version`: offline, before configuration.
- `mcp_worker setup --server https://<trusted-server>`: prompt for one-time enrollment token (do not pass tokens on a shell command line).
- `mcp_worker config show`: local redacted public settings only.
- `mcp_worker connection test`: tests HTTP(S) `/healthz` and `/readyz`, **not** proof of authenticated WSS/online Worker.
- `mcp_worker re-enroll --confirm --server https://<another-trusted-server>`: the Worker must be stopped and unmanaged. It creates a new identity and stores the previous `config.json` and `state.json` in a mode-0700 backup directory under `~/.worker_mcp`. An enrollment failure does not replace the prior identity; old identity must be revoked in Admin once migration succeeds.

`worker_mcp` CLI remains compatible with existing local integrations. One installation connects to one server; no automatic server switching.

## GitHub-first private RC templates

Run `npm run build && node scripts/render-worker-github-rc.cjs` on the development PC. Generated files under ignored `worker/dev-bin/github-rc/` are **fail-closed templates with empty approval pins**. They reference the repository's release-asset path, not MCP Server distribution. They cannot install without owner-reviewed, source-pinned release metadata and a valid detached RSA signature; no private signing key is generated or stored.

Existing eight `worker_mcp-<os>-<arch>` artifact names, nine-entry canonical manifest, detached signature verification, key fingerprint pinning, semver anti-downgrade and automatic binary rollback are reused from `src/routes/workerRoutes.ts`. The GitHub renderer is *not* exposed on a public route. GitHub asset redirects are permitted only over HTTPS and all downloaded bytes are verified against owner-pinned signed checksums. Legacy server-installer redirects remain prohibited.

Before a future release, complete owner signing outside this repo and record the exact version, 40-character commit, approved public key + SPKI digest, all 9 artifact digests, detached signature, HTTPS origin and native Linux/macOS/Windows lifecycle evidence. Keep `workerDistributionBlocked()=true` until **separate** owner approval. Manual downgrade remains prohibited; automatic restoration is only for a failed replacement.

## QA status

Linux Go unit tests, Node signed installer regression tests and offline fail-closed templates are testable on PC. Native Windows PowerShell syntax parsing is *not* Windows install/lifecycle acceptance. Native macOS acceptance remains NOT_TESTED when no device is available. The Server deployment and its SQLite volume must not be changed for this work.
