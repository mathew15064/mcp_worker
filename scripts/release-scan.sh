#!/bin/sh
# Image SBOM and vulnerability gate. No registry push, no Docker socket in scanner.
set -eu
[ "$#" -eq 3 ] || { echo 'Usage: release-scan.sh APP_IMAGE MYSQL_IMAGE EVIDENCE_DIR' >&2; exit 2; }
IMAGE="$1"
mkdir -p "$3"
OUT="$(cd "$3" && pwd)"
TRIVY="aquasec/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb"
MYSQL="$2"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$TMP/cache"
# Optional freshly downloaded cache. Trivy still checks DB freshness/updates.
if [ -n "${BOT_REPORT_TRIVY_CACHE:-}" ]; then
  cp -R "$BOT_REPORT_TRIVY_CACHE/db" "$TMP/cache/"
fi
scan() {
  docker run --rm -v "$TMP:/scan" -v "$OUT:/evidence" "$TRIVY" --cache-dir /scan/cache "$@"
}
scan --version >"$OUT/scanner-version.txt"
failed=0
for name in app mysql; do
  case "$name" in app) ref="$IMAGE";; mysql) ref="$MYSQL";; esac
  docker image inspect "$ref" >/dev/null || docker pull "$ref"
  docker image save "$ref" -o "$TMP/image.tar"
  scan image --input /scan/image.tar --format cyclonedx --output "/evidence/$name.sbom.cdx.json" --scanners vuln
  scan image --input /scan/image.tar --format json --output "/evidence/$name.vulnerabilities.json" --scanners vuln --severity HIGH,CRITICAL --exit-code 1 || failed=1
  rm -f "$TMP/image.tar"
done
[ "$failed" -eq 0 ] || { echo 'Release blocked: HIGH/CRITICAL findings or scanner failure. Review evidence.' >&2; exit 1; }
echo 'Image vulnerability gate PASS.'
