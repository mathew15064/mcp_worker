#!/bin/sh
# Local-only signed Worker verification. Never signs or publishes production artifacts.
set -eu
umask 077

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
need() { command -v "$1" >/dev/null 2>&1 || { echo "[T2] missing tool: $1" >&2; exit 2; }; }
need node
need npm
need openssl
need git
need go

[ -d node_modules ] || {
  echo "[T2] dependencies missing; run 'npm ci' locally before this script" >&2; exit 2;
}
[ ! -e worker/bin/SHA256SUMS.sig ] || {
  echo "[T2] refusing to run against a signed release artifact in worker/bin" >&2; exit 2;
}
# The real key and approved release pin must not be present in this verification.
echo "[T2] signed-release tests: local ephemeral keys and loopback HTTP fixtures only"
npm run typecheck
npm run build
node --test --test-concurrency=1 dist/tests/worker-signed-release.test.js

GO_BIN="${GO_BIN:-go}"
echo "[T2] Go module toolchain: $(cd worker-go && GOTOOLCHAIN=auto "$GO_BIN" version)"
( cd worker-go && GOTOOLCHAIN=auto "$GO_BIN" test ./... )

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/worker-t02-go.XXXXXXXX")"
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

SOURCE_COMMIT="$(git rev-parse --short=12 HEAD)"
TEST_VERSION=0.0.0
( cd worker-go && CGO_ENABLED=0 GOTOOLCHAIN=auto GOOS=linux GOARCH=amd64 "$GO_BIN" build \
  -buildvcs=false -trimpath \
  -ldflags "-X main.version=$TEST_VERSION -X main.commit=$SOURCE_COMMIT" \
  -o "$TEMP_DIR/systemtd-linux-amd64" . )
if [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]; then
  OUTPUT="$("$TEMP_DIR/systemtd-linux-amd64" version)"
  case "$OUTPUT" in "systemtd $TEST_VERSION commit=$SOURCE_COMMIT runtime="*) ;;
    *) echo "[T2] locally built Go binary returned unexpected version/commit" >&2; exit 1;;
  esac
  echo "[T2] PASS: Linux/amd64 native Go binary version/commit"
else
  echo "[T2] NOT_TESTED: Linux/amd64 native execution (host differs)"
fi

if [ "${SIGNED_WORKER_CROSS_BUILD:-0}" = 1 ]; then
  for target in darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
    os="${target%/*}"
    arch="${target#*/}"
    echo "[T2] cross-build only: $target (native execution NOT_TESTED)"
    ( cd worker-go && CGO_ENABLED=0 GOTOOLCHAIN=auto GOOS="$os" GOARCH="$arch" "$GO_BIN" build \
      -buildvcs=false -trimpath \
      -ldflags "-X main.version=$TEST_VERSION -X main.commit=$SOURCE_COMMIT" \
      -o "$TEMP_DIR/systemtd-$os-$arch" . )
  done
fi
echo "[T2] PASS: local signed Worker verification; no release signing/publication"
