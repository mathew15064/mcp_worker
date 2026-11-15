# Local verification and Docker publishing

Use the single PC checkout of GitHub `main`. Builds and tests are **local**;
there is no GitHub Actions or CI/CD release workflow. Do not use
Railway-specific Dockerfiles or templates.

## Fast checks

With Node 22 and dependencies already installed:

```sh
npm run typecheck
npm run lint:typed
npm run build
node --test --test-concurrency=1 dist/tests/*.test.js
```

For isolated PC gates (including Go tests, OAuth/WSS, optional Chromium,
disposable MySQL, and local Docker images):

```sh
bash scripts/local-verify-quickstart.sh --targeted
T5_BROWSER_SANDBOX=1 bash scripts/local-verify-quickstart.sh --full
```

The full runner records PASS, FAIL and NOT_TESTED in a private temporary
directory. It returns 3 when mandatory prerequisites are missing; this is
**not** an application test failure. Do not point any test to live data.
MySQL gates require an explicit disposable localhost database and
`T5_MYSQL_SANDBOX=1`. Chromium, Docker and non-root recovery require
their respective documented opt-in environment variables. Go module
tests use a locally cached module-compatible toolchain.

## Verify a standalone image

The server image is built with `Dockerfile` (Node 22, pinned Go
1.26.10 Worker builder); the optional bundled database image uses
`Dockerfile.mysql`.

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

`scripts/release-scan.sh` performs separately approved offline Trivy and
CycloneDX checks against the app and MySQL images. It requires the pinned
scanner and recent database cache. Check high/critical results before any
publication, and inspect the registry manifest digest **after** pushing;
the Docker image ID is not that digest.

## Release boundaries

Existing `v2.0.0-rc.1` points to a tested immutable application commit and
a separately published registry digest. Later source cleanup on `main`
does not change that image. Publish a new tag/digest only for a newly
reviewed image. Production-signed Worker downloads are still disabled;
see [signing policy](WORKER_SIGNED_RELEASE_POLICY.md). External HTTPS
connection, independent backup/restore and native-platform acceptance
require separate evidence before a stable release.
