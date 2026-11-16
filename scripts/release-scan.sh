#!/bin/sh
# Explicit, offline, PC-local SBOM/Trivy gate for the SQLite-only app image.
# No image pull, registry push or scanner download.
set -eu
[ "$#" -eq 2 ] || { echo 'Usage: release-scan.sh LOCAL_APP_IMAGE EVIDENCE_DIR' >&2; exit 2; }
[ "${T5_ALLOW_LOCAL_TRIVY_SCAN:-0}" = 1 ] || {
  echo 'NOT_TESTED: set T5_ALLOW_LOCAL_TRIVY_SCAN=1 only for approved cached scanner/images/DB' >&2; exit 3;
}
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || {
  echo 'NOT_TESTED: Docker daemon unavailable' >&2; exit 3;
}
TRIVY='aquasec/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb'
for image in "$TRIVY" "$1"; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "NOT_TESTED: required local scanner/image not cached (never pull): $image" >&2; exit 3;
  }
done
[ -n "${MCP_WORKER_TRIVY_CACHE:-}" ] && [ -d "$MCP_WORKER_TRIVY_CACHE/db" ] || {
  echo 'NOT_TESTED: offline Trivy DB cache absent; cannot claim fresh vulnerability coverage' >&2; exit 3;
}
OUT="$2"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$TMP/cache"
cp -R "$MCP_WORKER_TRIVY_CACHE/db" "$TMP/cache/db"
scan() {
  docker run --rm --pull=never --network=none --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" -v "$TMP:/scan" -v "$OUT:/evidence" "$TRIVY" \
    --cache-dir /scan/cache "$@"
}
scan --version > "$OUT/scanner-version.txt"
docker image save "$1" -o "$TMP/image.tar"
failed=0
scan image --offline-scan --skip-db-update --input /scan/image.tar --format cyclonedx \
  --output "/evidence/app.sbom.cdx.json" --scanners vuln || failed=1
scan image --offline-scan --skip-db-update --input /scan/image.tar --format json \
  --output "/evidence/app.vulnerabilities.json" --scanners vuln \
  --severity HIGH,CRITICAL --exit-code 1 || failed=1
[ "$failed" -eq 0 ] || { echo 'FAIL: Trivy error or HIGH/CRITICAL findings; release NO_GO' >&2; exit 1; }
echo 'LOCAL_TRIVY_PASS: cached offline DB checked; DB freshness/complete coverage requires separate review'
