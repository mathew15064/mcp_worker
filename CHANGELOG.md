# Changelog

## v2.0.0-rc.2 — 2026-11-15 (public Docker image candidate)

- Published Linux/amd64 Docker image `mathew15604/mcp-worker:2.0.0-rc.2` from
  source commit `b237d156ff49669127bfafdf700d4886746f29a5`.
- Immutable OCI index digest: `sha256:001bb9642fd5b5098c29cecc15dc466f29a5d6d7725be84b9565134ca3b`.
- Simplified source: retired Railway deploy/CI assets, stale reports,
  global npm from the running image, and legacy Node Worker agent/CLI.
  The Go Worker is the only shipped Worker implementation.
- Verified locally: 169 Node tests passed (0 failed, 9 skipped), real Go
  Worker WSS/OAuth 3/3, Chromium 16/16, Go unit/race/vet, Docker provenance,
  non-root HTTP health, and Trivy app/MySQL 0 HIGH/CRITICAL.
- Existing enrolled identities are not changed. Public signed Worker
  distribution remains disabled (HTTP 503); external ChatGPT HTTPS and
  offsite restore are not yet release-certified. Linux/amd64 only.
- No Railway deployment, CI/CD or `latest` Docker tag.

## v2.0.0-rc.1 — 2026-11-15 (historical Docker image candidate)

- First public standalone Linux/amd64 Docker RC, sourced from
  `ee27c57b5bba0d9e71693efeeb4702c4f1a839ea`.
- Image digest: `sha256:d520acbefafc64f45f6217e95e35271c1be716c2c2c37f0b12295cae8aff2bf5`.
- Includes the initial Worker-only MCP service, OAuth, admin UI, local
  Docker quickstart and signed-distribution fail-closed controls.
- This version remains published for reproducibility; it is not
  overwritten by the `rc.2` update.
