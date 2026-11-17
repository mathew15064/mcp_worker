#!/bin/sh
# OWNER-OPERATED, OFFLINE ONLY. Run on an owner-controlled local signing device.
# Never run on VPS, CI, a shared build agent or any machine with untrusted access.
set -eu
umask 077

[ "$#" -eq 1 ] || {
  echo 'Usage: create-worker-signing-key.sh /absolute/owner-controlled-empty-directory' >&2
  exit 2
}
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
TARGET="$1"
case "$TARGET" in /*) ;; *) echo '[worker-key] absolute key directory required' >&2; exit 2;; esac
[ -d "$TARGET" ] && [ ! -L "$TARGET" ] || {
  echo '[worker-key] create a private directory (0700) outside the source checkout first' >&2
  exit 2
}
TARGET="$(CDPATH= cd -- "$TARGET" && pwd -P)"
case "$TARGET/" in "$ROOT/"|"$ROOT/"*) echo '[worker-key] private key must stay outside the source repository' >&2; exit 2;; esac
[ "$(stat -c %a "$TARGET")" = 700 ] || {
  echo '[worker-key] owner-only directory mode 0700 required' >&2; exit 2
}
[ "$(id -u)" = "$(stat -c %u "$TARGET")" ] || {
  echo '[worker-key] directory must be owned by current user' >&2; exit 2
}
for file in private.pem public.pem public-spki-sha256.txt; do
  [ ! -e "$TARGET/$file" ] && [ ! -L "$TARGET/$file" ] || {
    echo '[worker-key] existing key material refused (never overwrite)' >&2; exit 2;
  }
done
command -v openssl >/dev/null 2>&1 || {
  echo '[worker-key] OpenSSL required' >&2; exit 2;
}
TEMP="$(mktemp -d "$TARGET/.keygen.XXXXXXXX")"
trap 'rm -rf "$TEMP"' EXIT
trap 'exit 1' HUP INT TERM
# Generate 4096-bit RSA with operating-system CSPRNG, PKCS#8 PEM format.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$TEMP/private.pem" 2>"$TEMP/progress.log"
openssl rsa -in "$TEMP/private.pem" -check -noout >/dev/null 2>&1 || {
  echo '[worker-key] RSA private key failed validation' >&2; exit 1;
}
openssl pkey -in "$TEMP/private.pem" -pubout -out "$TEMP/public.pem" 2>/dev/null
FINGERPRINT="$(openssl pkey -pubin -in "$TEMP/public.pem" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
printf '%s' "$FINGERPRINT" | grep -Eq '^[0-9a-f]{64}$' || exit 1
printf '%s\n' "$FINGERPRINT" > "$TEMP/public-spki-sha256.txt"
chmod 0600 "$TEMP/private.pem"
chmod 0644 "$TEMP/public.pem" "$TEMP/public-spki-sha256.txt"
# All materials are prepared before publishing. Never overwrite existing keys.
mv "$TEMP/public.pem" "$TARGET/public.pem"
mv "$TEMP/public-spki-sha256.txt" "$TARGET/public-spki-sha256.txt"
mv "$TEMP/private.pem" "$TARGET/private.pem"
echo '[worker-key] RSA-4096 pair generated on this machine; private key never uploaded.'
echo "[worker-key] public SPKI SHA-256: $FINGERPRINT"
echo '[worker-key] independently verify the public fingerprint, securely back up the private key offline, then approve the fingerprint before signing.'
