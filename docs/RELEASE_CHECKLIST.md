# Docker-only release checklist

The [public standalone Docker image](https://hub.docker.com/r/mathew15604/mcp-worker)
is an **RC, not a production-signed Go Worker release**. GitHub `main` is
the ongoing baseline; `v2.0.0-rc.1` fixes the original tested source
commit `ee27c57b5bba0d9e71693efeeb4702c4f1a839ea`.

- Docker Hub: `mathew15604/mcp-worker:2.0.0-rc.1` (Linux/amd64).
- Immutable registry digest:
  `sha256:d520acbefafc64f45f6217e95e35271c1be716c2c2c37f0b12295cae8aff2bf5`.
- On the RC source: **21 PC QA gates passed, 0 failed**, with 5 additional
  optional/external gates not tested by that runner. MySQL, Chromium, Go and
  local Docker integration were included.
- Separately, fresh Trivy scans of standalone app, Railway-era app, and MySQL
  images found **0 HIGH/CRITICAL**; production `npm audit` found 0
  vulnerabilities (nine moderate advisories in development tooling).
- GitHub Actions workflows were removed. No CI/CD or Railway deployment is
  required to run the public image.

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
