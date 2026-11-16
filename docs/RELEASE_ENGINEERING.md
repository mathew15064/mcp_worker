# SQLite-only release engineering (development)

This branch builds **one application image and one SQLite app-data volume**. There is no MySQL image, MySQL driver, online database conversion or dual database mode. The earlier `v2.0.0-rc.2` image/tag is historical and is **not** evidence for this source commit.

## Source checks

Run from the reviewed, clean branch with Node 22:

```sh
npm ci
npm run typecheck
npm run lint:typed
npm run format:check
npm test
```

The source must match the exact Git commit being reviewed. Node TAP skips are not release evidence for the skipped scenario. Execute targeted native/Worker/browser tests in disposable environments when their prerequisites are available:

```sh
bash scripts/local-verify-quickstart.sh --targeted
T5_BROWSER_SANDBOX=1 bash scripts/local-verify-quickstart.sh --full
```

The full runner records PASS / FAIL / NOT_TESTED. A missing required gate returns a **NO_GO**, not an implicit pass. The optional isolated outbound Go Worker test uses fresh SQLite in a disposable Docker container, never an external database.

## Build a candidate, never overwrite an existing tag

```sh
sha="$(git rev-parse HEAD)"
tree="$(git rev-parse 'HEAD^{tree}')"
test -z "$(git status --porcelain)"
docker build --pull=false -f Dockerfile \
  --build-arg "BOT_REPORT_GIT_SHA=$sha" \
  --build-arg "BOT_REPORT_TREE_SHA=$tree" \
  --build-arg "BOT_REPORT_BUILD_TIME=$(git show -s --format=%cI HEAD)" \
  -t mcp-worker-local:review .
bash scripts/verify-oci-image-local.sh mcp-worker-local:review standalone
```

Test a new Compose project with `BOT_REPORT_SETUP_PROJECT` and `BOT_REPORT_SETUP_PORT` on an unused loopback port. Check `./setup.sh --init`, Admin login, readiness, OAuth PKCE, 15 MCP tools, Worker identity, stop/restart persistence, and the Worker installer 503 gate. Keep user volumes out of tests.

The separately approved offline Trivy / CycloneDX gate now accepts only the application image:

```sh
T5_ALLOW_LOCAL_TRIVY_SCAN=1 BOT_REPORT_TRIVY_CACHE=/private/scanner-cache \
  sh scripts/release-scan.sh mcp-worker-local:review /private/evidence
```

The scanner image, vulnerability DB and application image must already be cached. This command never pulls, pushes or signs; check vulnerability DB freshness and findings explicitly.

## Release boundary

A passing local build is a **source candidate**, not proof that production signing roots, external HTTPS/ChatGPT OAuth, off-host recovery, supply-chain/license review or target-platform Worker installers have been approved. Until independent release-signing approval, `/worker/install*` and `/worker/dist/*` remain HTTP 503. A new immutable tag/digest requires explicit release authorization; do not rewrite `v2.0.0-rc.2`.
