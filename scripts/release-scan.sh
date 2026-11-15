#!/bin/sh
# Explicit, offline, PC-local SBOM/Trivy gate. No image pull, registry push or scanner download.
set -eu
[ "$#" -eq 3 ] || { echo 'Usage: release-scan.sh LOCAL_APP_IMAGE LOCAL_MYSQL_IMAGE EVIDENCE_DIR' >&2; exit 2; }
[ "${T5_ALLOW_LOCAL_TRIVY_SCAN:-0}" = 1 ] || {
  echo 'NOT_TESTED: set T5_ALLOW_LOCAL_TRIVY_SCAN=1 only for approved cached scanner/images/DB' >&2; exit 3;
}
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || {
  echo 'NOT_TESTED: Docker daemon unavailable' >&2; exit 3;
}
TRIVY='aquasec/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb'
for image in "$TRIVY" "$1" "$2"; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "NOT_TESTED: required local scanner/image not cached (never pull): $image" >&2; exit 3;
  }
done
[ -n "${BOT_REPORT_TRIVY_CACHE:-}" ] && [ -d "$BOT_REPORT_TRIVY_CACHE/db" ] || {
  echo 'NOT_TESTED: offline Trivy DB cache absent; cannot claim fresh vulnerability coverage' >&2; exit 3;
}
OUT="$3"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$TMP/cache"
cp -R "$BOT_REPORT_TRIVY_CACHE/db" "$TMP/cache/db"
scan() {
  docker run --rm --pull=never --network=none --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" -v "$TMP:/scan" -v "$OUT:/evidence" "$TRIVY" \
    --cache-dir /scan/cache "$@"
}
scan --version > "$OUT/scanner-version.txt"
failed=0
for name in app mysql; do
  if [ "$name" = app ]; then ref="$1"; else ref="$2"; fi
  docker image save "$ref" -o "$TMP/image.tar"
  scan image --offline-scan --skip-db-update --input /scan/image.tar --format cyclonedx \
    --output "/evidence/$name.sbom.cdx.json" --scanners vuln || failed=1
  scan image --offline-scan --skip-db-update --input /scan/image.tar --format json \
    --output "/evidence/$name.vulnerabilities.json" --scanners vuln \
    --severity HIGH,CRITICAL --exit-code 1 || failed=1
  rm -f "$TMP/image.tar"
done
[ "$failed" -eq 0 ] || { echo 'FAIL: Trivy error or HIGH/CRITICAL findings; release NO_GO' >&2; exit 1; }
echo 'LOCAL_TRIVY_PASS: cached offline DB checked; DB freshness/complete coverage requires separate review'
