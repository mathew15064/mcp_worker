# Release engineering (local verification)

This workflow never publishes images, creates tags or signs releases. Run on a
disposable Linux Docker host from a clean committed checkout:

    ./scripts/release-verify.sh
    ./scripts/release-scan.sh "$(cat reports/<run>/image.txt)" "$(cat reports/<run>/mysql-image.txt)" reports/<run>

The first script allocates a random Compose project, separate test database,
temporary containers and credentials; it removes only its own state on exit.
It verifies a fresh install, stop/start persistence, native SQLite, Worker
artifacts, all 19 MCP tools and live Linux upgrade/rollback with a distinct
fixture binary. Set BOT_REPORT_RELEASE_PORT if the default loopback port
13336 is occupied. Logs and image identity are retained under reports/.
The local image is retained for scanning. The scan uses a pinned Trivy image,
without mounting the Docker socket, emits CycloneDX SBOM and HIGH/CRITICAL
vulnerability JSON for app and bundled MySQL, and fails closed on findings or
scanner failure. Vulnerability data must be downloaded and current. An optional BOT_REPORT_TRIVY_CACHE points to a previously downloaded Trivy cache; the script copies its DB into temporary storage and leaves Trivy update checks enabled.

CI uses Node 26.13.0 and Go 1.26.10; production Node, Go builder and the
upstream MySQL base references pin registry manifest digests. The runtime
image upgrades npm to 11.21.2 using a verified tarball. Dockerfile.mysql
retains upstream MySQL 8.4.13 and its entrypoint, removes optional mysql-shell
(not required for mcp_worker), and rebuilds gosu 1.19 from an exact upstream
commit with Go 1.26.10. The standalone installer builds both images locally;
advanced external database configurations remain unchanged. Scan the actual
built app and database images, not just their upstream bases. Refresh pins deliberately
after testing. APK packages and vulnerability databases can change; this is
not a claim of bit-identical whole-image reproducibility. Worker metadata
records the Git commit and version. The workflow uploads unsigned artifacts
only when gates pass; approval, sanitized history, license/notice review,
signing keys, release tags and external publication are separate steps.

Native Go CI runs on Linux/macOS/Windows. Cross-builds do not prove native
installer lifecycle, systemd recovery, remote HTTPS connectivity or browser
compatibility outside the tested environments. Do not publish until those
release gates and security review are explicitly accepted.
