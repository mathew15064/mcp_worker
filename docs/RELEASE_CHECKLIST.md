# SQLite-only release readiness checklist

Scope: new standalone Docker installation from a **clean and reviewed source commit**; not an upgrade from earlier database formats. An older `v2.0.0-rc.2` image/tag remains a distinct historical build.

- [ ] Source tree clean, `package-lock.json` matches `package.json`, one SQLite runtime adapter and no MySQL library/image/importer; record the exact Git SHA.
- [ ] Typecheck, typed lint, formatter, complete Node test suite, and no unexpected skips; verify the 15-tool MCP schema hash against baseline.
- [ ] Build a fresh local single-app Docker image and verify its commit/tree labels, non-root runtime and native SQLite addon.
- [ ] Run isolated fresh `./setup.sh --init` with three generated secrets, Admin login, User/OAuth PKCE, Worker registration, WSS, audited tool calls, restart persistence and permission guards.
- [ ] Confirm unauthenticated MCP requests are rejected and unsigned Worker installation/distribution endpoints return HTTP 503. Do **not** disable the gate to claim a release pass.
- [ ] Run available Go test/race/vet and native signed installer negative/rollback tests. Record unavailable native OS/browser tests as NOT_TESTED.
- [ ] Scan the single image and generated Worker binaries for dependencies, licenses and vulnerabilities; document the scanner DB recency and third-party notices.
- [ ] For external client use: separately certify HTTPS reverse proxy, OAuth discovery/consent/PKCE, WSS transport, cookie security and exact public origin.
- [ ] For stable Worker distribution: separately approve production signing material and target-platform native installer acceptance.
- [ ] If real users/data will be retained, obtain separately approved backup/restore and rollback proof; no backup/restore gate is required to **reset a disposable development database**.

No Git push, deployment, production signing, registry publication or existing-data deletion is implied by this checklist. See [local release engineering](RELEASE_ENGINEERING.md), [quickstart](QUICKSTART.md) and [signed Worker policy](WORKER_SIGNED_RELEASE_POLICY.md).
