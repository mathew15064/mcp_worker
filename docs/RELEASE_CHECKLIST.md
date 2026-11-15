# Docker-only release checklist

The [public standalone Docker image](https://hub.docker.com/r/mathew15604/mcp-worker)
is a **release candidate**, not a production-signed Go Worker installer release.
GitHub `main` remains the development baseline.

- Latest Docker Hub tag: `mathew15604/mcp-worker:2.0.0-rc.2` (Linux/amd64).
- Tested source: Git tag [`v2.0.0-rc.2`](https://github.com/mathew15064/mcp_worker/tree/v2.0.0-rc.2),
  commit `b237d156ff49669127bfafdf700d4886746f29a5`.
- Immutable OCI index digest: `sha256:001bb9642fd5b5098c29cecc15dc466f29c66e3a5d6d7725be84b9565134ca3b`.
- **Erratum:** The already-published annotated Git tag message contains a truncated
  image digest. Use the verified 64-hex-character digest above instead; do not
  rewrite the source tag or overwrite the registry image.
- PC checks: 169 Node tests passed (0 failed, 9 skipped), 3 real Go Worker WSS/OAuth
  tests, 16 Chromium tests, Go unit/race/vet, exact-commit Docker build,
  provenance verification and non-root HTTP health smoke.
- Trivy: **0 HIGH/CRITICAL** for locally scanned app and MySQL images;
  CycloneDX SBOMs were generated. The cached DB and scope of each scan must
  still be reviewed independently for a stable release.
- The legacy Node Worker runtime, unused Railway assets and runtime npm CLI
  have been removed from the new source/image; old Git tag
  `v2.0.0-rc.1` and its Docker image remain unchanged.
- No GitHub Actions workflows, CI/CD or Railway deployment were used.

## Before labeling a future release stable

- [ ] Pin an exact clean commit and independently test/re-scan its new Docker
  image. Record a new immutable registry digest; never silently overwrite
  the RC tag.
- [ ] Approve a production signing root, sign and verify Worker manifest
  and binaries, and perform native installer acceptance. Until then
  `/worker/install*` and `/worker/dist/*` remain HTTP 503.
- [ ] Validate secure setup, OAuth consent and Worker enrollment on a
  controlled HTTPS endpoint if offering remote MCP/ChatGPT use.
- [ ] Verify off-host encrypted backup and independent restore, recovery
  keys and permissions for any real user data.
- [ ] Review third-party licenses and security disclosure routes.

Use [release engineering](RELEASE_ENGINEERING.md),
[signed Worker policy](WORKER_SIGNED_RELEASE_POLICY.md), and
[backup/restore](BACKUP_RESTORE.md) for details. Do not use test-only keys
or temporary Docker volumes for production.
