#!/bin/sh
# Run only in an authorized release signing environment. Never copy private keys into images.
set -eu
umask 077
[ "$#" -eq 1 ] || { echo "Usage: $0 /absolute/path/to/private-signing-key.pem" >&2; exit 2; }
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT/worker/bin"
test -f SHA256SUMS
sha256sum -c SHA256SUMS
tmp="$(mktemp ./SHA256SUMS.sig.XXXXXX)"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
openssl dgst -sha256 -sign "$1" -out "$tmp" SHA256SUMS
chmod 644 "$tmp"
mv -f "$tmp" SHA256SUMS.sig
echo 'Worker manifest signed. Publish signature, manifest and matching binaries together.'
