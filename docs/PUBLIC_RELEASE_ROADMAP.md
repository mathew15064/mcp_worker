# mcp_worker V2 — public self-hosted release roadmap

## Scope

V2 Final is the main-branch baseline: 19 technical MCP tools, outbound Go Worker, SSH compatibility, OAuth, MySQL, bounded execution and audit. No new V3 business modules. This repository is the source release candidate; do not publish stable signed artifacts until the release gates below pass. Preserve existing installed deployments and their configuration/data; public defaults must not silently migrate or reset existing databases.

## Milestones

1. **Publication hygiene:** audit all tracked files and dependencies for secrets, internal infrastructure references, personal information and licensing. Exclude operational reports, private environment files, historical patch rejects and obsolete tooling. Review game/fight web modules separately; they are not part of the public coding product. The owner-provided MIT LICENSE is retained; review third-party distribution terms. Preserve original private history separately; publish only sanitized history.
2. **Standalone quickstart:** add a default self-contained Docker Compose stack (app, dedicated MySQL, persistent named volumes, private network, loopback-only web port). Retain external-proxy deployment as an advanced example rather than a requirement. Add idempotent setup command with generated per-install secrets, secure permissions, no hard-coded passwords, no automatic database reset or global package upgrade. Initialize only an explicitly selected fresh dedicated database; external/existing DB uses current test/save/initialize workflow. Document uninstall with data preservation.
3. **First-run onboarding:** guided admin login/bootstrap, database readiness, base URL and HTTPS/proxy configuration, Worker enrollment, OAuth client setup, a read-only first MCP call. Do not persist enrollment tokens or expose credentials in logs. Make safe failure and recovery paths explicit.
4. **Worker lifecycle:** one supported Go installer per platform; versioned checksums and signed release artifacts; default non-root, explicit allowed roots and shell permission, diagnose connectivity, upgrade/rollback/uninstall preserving identity and configuration. SSH stays optional advanced transport. Allowed roots are not a shell sandbox.
5. **Release engineering:** align Dockerfile, CI and supported Node runtime with the tested runtime, pin images and worker build metadata, native dependency verification, Linux/macOS/Windows tests, clean-install E2E and upgrade/rollback tests. Publish reproducible tagged images and binaries only after gates. Keep package private for npm unless npm publication is explicitly wanted.
6. **Public documentation and governance:** concise README quickstart, architecture/security model, troubleshooting, backup/restore, contributor guide, security reporting policy, changelog and issue templates. No default public admin exposure, no credentials in examples, no claims of compatibility without tests.

## Current local status

P8.1–P8.5.1 have completed local source preparation, standalone/onboarding,
Linux lifecycle, release engineering and security remediation. P8.6 adds
public-facing documentation and governance. These are not publication
approval: see the [release checklist](RELEASE_CHECKLIST.md) for pending
owner, platform and external verification gates.

## Acceptance gates

- A new user on a clean Docker host can start with one documented command and make an authenticated read-only MCP call; target 5–10 minutes on a suitable machine, not a measured promise.
- Dedicated fresh MySQL initializes safely; restart/upgrade retain settings, keys, database, worker enrollment and OAuth tokens. Existing DB cannot be automatically reset.
- TLS reverse proxy and remote MCP client verified; no unauthenticated tools; worker owner boundaries, scope checks and revocation tested.
- All 19 tools tested through real Workers; OS installer paths verified; current V2 regression, MySQL integration, Go race and UI tests pass.
- Clean public tree and history scanned; explicit owner license decision; dependency notices; reproducible tagged release, backup/rollback and CI artifacts.

## Deployment distinction

Public repository preparation is independent of the existing production service. No production migration, rename, branch force-push or public repository creation is implied.
