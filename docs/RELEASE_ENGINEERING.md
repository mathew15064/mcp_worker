# Release engineering — PC-only Wave 3 QA runbook

**Status: NO_GO.** This is an executable local QA plan, not permission for a
release, GitHub Actions, external services, dependency downloads, production
signing, Docker push, Railway project, or database modification outside
explicitly disposable fixtures. The authoritative source is Bot Report 2,
profile `PC`, not GitHub main.

## Verify the correct source before any edit or execution

Use the single checkout `/root/mcpw_v200_full5_integration_test_20261114`, branch
`work/full5-integration-test-20261114`. The old T5 task worktree and
`48473a3` SHA were removed/superseded. The QA script reads the active HEAD
and tree and records them in its local evidence. For independently reviewed
release source, set `T5_EXPECTED_SHA` and `T5_EXPECTED_TREE` to the exact
approved 40-character values before running. Before running, check:

```sh
git rev-parse HEAD
git rev-parse HEAD^{tree}
git branch --show-current
git diff --binary | sha256sum
git status --short
```

Reject any unexpected HEAD/tree/branch drift. Do not use the deleted
T1–T5 worktrees or their old pinned verification evidence as current release proof.

## Small-change smoke then explicit full PC QA

From the T5 worktree, with existing Node 22 and an already installed
lockfile-matching `node_modules` (no automatic `npm ci`):

```sh
bash scripts/local-verify-quickstart.sh --targeted
T5_BROWSER_SANDBOX=1 bash scripts/local-verify-quickstart.sh --full
```

The harness writes a new mode-0700 local `/tmp/t5-qa.*` folder
(or `T5_QA_OUT` chosen outside the worktree) with `context.txt`,
`results.tsv`, `summary.json`. It runs each command once,
preserves TAP pass/fail/skip counts, records every conditional suite and
its exact missing prerequisites, and stops further runnable gates after
a command failure. Return codes are **0** only when all required local
gates pass, **1** on an executed command failure, **3** for missing
mandatory gates or counted skips, **2** for refusal/bad context. An
optional Chromium subtest can legitimately SKIP, but that is never
evidence for the separate mandatory Playwright gate. No blanket
`npm test` or full Docker build is required for a tiny T5 edit.

For T5's 2026-11-14 PC execution, Node v22.22.3, npm 10.9.8,
cached Go 1.24.0, local Docker daemon and Playwright Chromium were
present. The full gate returned **NO_GO / exit 3** despite successful
Node, Go, loopback WSS, test-only signed lifecycle and browser tests.
The clean-source Docker and MySQL preconditions were not supplied.
Root-run recovery permissions caused one TAP SKIP. Preserve these gaps.

| Gate | Exact local prerequisites and safe procedure |
| --- | --- |
| Node, SQLite, signing unit | Node 22, npm dependencies already installed, lockfile match; `npm run build`, then targeted compiled Node tests |
| Native Linux signed lifecycle | Go 1.24 available offline, OpenSSL, Node compiled installer generator; `node scripts/test-linux-installer-lifecycle.cjs` generates two actual Go binaries, ephemeral RSA key and local loopback signatures; no production key |
| Go test/race/vet | Module-compatible cached Go 1.24; `GOPROXY=off`, `GOTOOLCHAIN=local`; no downloads |
| Loopback Go/WSS | Same Go/OpenSSL/Node dependencies; `BOT_REPORT_W2_T03_GO_E2E=1` and `BOT_REPORT_W3_T04_GO_E2E=1` are set by `--full` for isolated fixtures |
| MySQL integration/setup/Worker | An **operator-created disposable localhost MySQL server**, isolated schema and credentials; explicitly set `T5_MYSQL_SANDBOX=1`, `MYSQL_TEST_HOST=127.0.0.1` or `localhost`, `MYSQL_TEST_DATABASE`, and the needed `MYSQL_TEST_* ` credentials. Never point tests at production or a public IP |
| Mandatory Chromium | Cached executable returned by `@playwright/test`'s `chromium.executablePath()`, `T5_BROWSER_SANDBOX=1`, compiled Playwright config, unused local fixture port; absence is NOT_TESTED, never PASS |
| Railway and standalone OCI | Docker CLI/daemon, explicit `T5_ALLOW_DOCKER_BUILD=1`, **clean owner-approved committed source**, cached pinned Node/Go bases; default builds use `--pull=false --network=none`. If the isolated Docker cache lacks required modules, separately opt into dependency network access with `T5_ALLOW_BUILD_NETWORK=1` (still `--pull=false` and no push), then verify exact image/commit labels |
| Local OCI labels/runtime | `bash scripts/verify-oci-image-local.sh TAG railway` or `TAG standalone`: exact HEAD/TREE, flavor, Node22/Go1.24 base labels, local origin, Linux/amd64, entrypoint, UID, Node and Worker binary commit/runtime |
| Dependency audit | Actual approved registry connectivity and explicitly run `npm audit` on the accepted lockfile; otherwise NOT_TESTED. No current audit pass |
| SBOM + Trivy | Explicit `T5_ALLOW_LOCAL_TRIVY_SCAN=1`, cached pinned Trivy image, cached scanner DB and both local app/MySQL images; `scripts/release-scan.sh APP MYSQL OUT` refuses missing tools/images and never pulls |
| Other OS and offsite | Native Windows/macOS/systemd and independently authorized remote backup/restore; none are substituted by cross-compiled binaries or local volume snapshots |

Do not enable MySQL/Docker gates merely to get a green status. Missing
mandatory prerequisites imply `NO_GO`; an absent scanner database,
unverified image hash, old CI run or optional test SKIP cannot be
reclassified as PASS.

## Distinguish image products and provenance

`Dockerfile` is the **standalone** app image, with the bundled MySQL
service separately built from `Dockerfile.mysql`. `Dockerfile.railway`
is the **Railway SQLite** application image; it does not require the
bundled MySQL service. The current app runtime is pinned Node
`22.22.3-alpine`; the Worker builder is pinned Go `1.24`. The
MySQL Dockerfile has a separate pinned Go 1.26 gosu-builder, which is
**not** the Worker compiler and must be evaluated separately.
Both app images label source HEAD, source tree, image flavor, Node/Go
build bases and `local-pc-only`. Set `BOT_REPORT_GIT_SHA`,
`BOT_REPORT_TREE_SHA`, and `BOT_REPORT_BUILD_TIME` from an approved
clean commit for any independent build. A dirty local diff means the
committed tree cannot fully describe what the image contains; the
verifier correctly refuses it.

`scripts/verify-oci-image-local.sh` inspects and probes **only a
locally cached image**. Docker image ID, local RepoDigest and labels are
not a published registry manifest digest, signed SLSA attestation,
reproducibility proof or deployment approval. A registry
`repository@sha256:<manifest>` digest requires a separately approved
publish/inspect action, which this run did not perform.

`scripts/release-verify.sh` is a **legacy heavy standalone/MySQL
integration** harness, not the fast Wave3 default. It requires a clean
source and explicit, separately authorized
`T5_ALLOW_RELEASE_FULL=1 T5_ALLOW_RELEASE_NETWORK_BUILD=1` because
`setup.sh` may fetch Docker/OS dependencies. Do not invoke it during
this unapproved offline task. It now treats counted Node regression
skips as incomplete and its local image identity as standalone only.
`scripts/release-scan.sh` never pulls the pinned scanner or missing
images; a scan PASS requires actual completed execution and a DB
freshness review. Historical CI and Trivy records are not this PC run.

## Mandatory stop / final decision

Stop on any mismatch in source, trust pin, wrong-identity Worker,
untrusted build image, unexpected external endpoint, non-disposable DB,
missing key custody approval or failed security/OS gate. Preserve
sanitized exits/counts and tool versions; do not copy secrets, Docker
credentials, private keys, environment dumps or raw OAuth fixtures to
Drive. The Main reviewer may assess T5 evidence; only the owner can
authorize final integration, commit, cloud activity, signing or release.
Until all release criteria pass, leave signed Worker distribution at
HTTP 503 `WORKER_SIGNED_RELEASE_PENDING` and mark release **NO_GO**.
