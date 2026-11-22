#!/bin/sh
# Verifies an offline signed candidate without reading the private key.
set -eu
[ "$#" -eq 1 ] || {
  echo 'Usage: VERSION=x.y.z COMMIT=full40 WORKER_RELEASE_EXPECTED_PUBLIC_KEY_SHA256=full64 verify-worker-signed-release.sh /absolute/public.pem' >&2
  exit 2
}
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT="$ROOT/worker/bin"
KEY="$1"
[ -f "$KEY" ] && [ ! -L "$KEY" ] || { echo '[worker-verify] regular public key required' >&2; exit 2; }
case "$KEY" in /*) ;; *) echo '[worker-verify] absolute public key path required' >&2; exit 2;; esac
VERSION="${VERSION:-}"
COMMIT="${COMMIT:-}"
EXPECTED_FP="${WORKER_RELEASE_EXPECTED_PUBLIC_KEY_SHA256:-}"
printf '%s' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$' || exit 2
printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || exit 2
printf '%s' "$EXPECTED_FP" | grep -Eq '^[0-9a-f]{64}$' || exit 2
DERIVED_FP="$(openssl pkey -pubin -in "$KEY" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
[ "$DERIVED_FP" = "$EXPECTED_FP" ] || { echo '[worker-verify] public key fingerprint mismatch' >&2; exit 1; }
cd "$OUT"
for file in \
  worker_mcp-darwin-amd64 worker_mcp-darwin-arm64 \
  worker_mcp-linux-386 worker_mcp-linux-amd64 \
  worker_mcp-linux-arm64 worker_mcp-linux-armv7 \
  worker_mcp-windows-amd64.exe worker_mcp-windows-arm64.exe \
  WORKER_RELEASE SHA256SUMS SHA256SUMS.sig; do
  [ -f "$file" ] && [ ! -L "$file" ] || { echo "[worker-verify] missing/unsafe $file" >&2; exit 1; }
done
printf 'version=%s\ncommit=%s\n' "$VERSION" "$COMMIT" | cmp -s - WORKER_RELEASE || {
  echo '[worker-verify] metadata does not match expected version/commit' >&2; exit 1;
}
[ "$(wc -l < SHA256SUMS | tr -d ' ')" = 9 ] || { echo '[worker-verify] expected exactly nine checksum entries' >&2; exit 1; }
sha256sum worker_mcp-* WORKER_RELEASE | cmp -s - SHA256SUMS || {
  echo '[worker-verify] noncanonical or altered checksum inventory' >&2; exit 1;
}
sha256sum -c SHA256SUMS >/dev/null || { echo '[worker-verify] artifact checksum mismatch' >&2; exit 1; }
openssl dgst -sha256 -verify "$KEY" -signature SHA256SUMS.sig SHA256SUMS >/dev/null || {
  echo '[worker-verify] invalid RSA manifest signature' >&2; exit 1;
}
RUNTIME="$(./worker_mcp-linux-amd64 version)"
case "$RUNTIME" in
  "worker_mcp $VERSION commit=$COMMIT runtime="*) ;;
  *) echo '[worker-verify] executable version/commit mismatch' >&2; exit 1;;
esac
echo '[worker-verify] signed manifest, exact source metadata, key fingerprint, eight artifact checksums and Linux binary identity: PASS'
echo "[worker-verify] manifest_sha256=$(sha256sum SHA256SUMS | awk '{print $1}')"
echo "[worker-verify] signature_sha256=$(sha256sum SHA256SUMS.sig | awk '{print $1}')"
echo '[worker-verify] this test is NOT native Windows/macOS install acceptance or public-release approval'
