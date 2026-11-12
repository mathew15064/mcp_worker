#!/bin/sh
# Offline approval-only signing. Never place a real private key in source/CI.
set -eu
umask 077
[ "$#" -eq 1 ] || { echo "Usage: WORKER_RELEASE_EXPECTED_VERSION=x.y.z WORKER_RELEASE_EXPECTED_COMMIT=hex $0 /absolute/private-key.pem" >&2; exit 2; }
[ -n "$WORKER_RELEASE_EXPECTED_VERSION" ] && [ -n "$WORKER_RELEASE_EXPECTED_COMMIT" ] || { echo 'Release approval version/commit required' >&2; exit 2; }
case "$WORKER_RELEASE_EXPECTED_VERSION" in *[!0-9.]*|'') echo 'Invalid expected version' >&2; exit 2;; esac
case "$WORKER_RELEASE_EXPECTED_COMMIT" in *[!0-9a-f]*|'') echo 'Invalid expected commit' >&2; exit 2;; esac
KEY="$1"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT/worker/bin"
test -f SHA256SUMS && test -f WORKER_RELEASE
[ "$(wc -l < WORKER_RELEASE | tr -d ' ')" = 2 ] || { echo 'Invalid metadata length' >&2; exit 1; }
[ "$(sed -n '1p' WORKER_RELEASE)" = "version=$WORKER_RELEASE_EXPECTED_VERSION" ] || { echo 'Release version mismatch' >&2; exit 1; }
[ "$(sed -n '2p' WORKER_RELEASE)" = "commit=$WORKER_RELEASE_EXPECTED_COMMIT" ] || { echo 'Release commit mismatch' >&2; exit 1; }
# Reproduce manifest canonically: rejects missing/extra paths and duplicated hashes.
set -- \
  bot-report-worker-darwin-amd64 bot-report-worker-darwin-arm64 \
  bot-report-worker-linux-386 bot-report-worker-linux-amd64 \
  bot-report-worker-linux-arm64 bot-report-worker-linux-armv7 \
  bot-report-worker-windows-amd64.exe bot-report-worker-windows-arm64.exe WORKER_RELEASE
for file do test -f "$file" || { echo "Missing artifact: $file" >&2; exit 1; }; done
test "$(wc -l < SHA256SUMS | tr -d ' ')" = 9 || { echo 'Invalid manifest entry count' >&2; exit 1; }
sha256sum bot-report-worker-* WORKER_RELEASE | cmp -s - SHA256SUMS || {
  echo 'Noncanonical or modified SHA256SUMS' >&2; exit 1;
}
sha256sum -c SHA256SUMS >/dev/null
openssl rsa -in "$KEY" -check -noout >/dev/null 2>&1 || { echo 'An RSA signing key is required' >&2; exit 1; }
tmp="$(mktemp ./SHA256SUMS.sig.XXXXXX)"
pub="$(mktemp ./release-public.XXXXXX)"
trap 'rm -f "$tmp" "$pub"' EXIT HUP INT TERM
openssl rsa -in "$KEY" -pubout -out "$pub" >/dev/null 2>&1
openssl dgst -sha256 -sign "$KEY" -out "$tmp" SHA256SUMS
openssl dgst -sha256 -verify "$pub" -signature "$tmp" SHA256SUMS >/dev/null || {
  echo 'Self-verification failed' >&2; exit 1;
}
chmod 644 "$tmp"
mv -f "$tmp" SHA256SUMS.sig
echo 'Signed candidate verified locally. No publication or approval implied.'
