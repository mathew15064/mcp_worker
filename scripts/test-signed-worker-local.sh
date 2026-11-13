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
GO_VERSION="$(cd worker-go && GOTOOLCHAIN=auto "$GO_BIN" version)"
case "$GO_VERSION" in *"go1.24."*) ;; *) echo "[T2] Go 1.24 is required: $GO_VERSION" >&2; exit 2;; esac
echo "[T2] Go module toolchain: $GO_VERSION"
( cd worker-go && GOTOOLCHAIN=auto "$GO_BIN" test ./... )
( cd worker-go && GOTOOLCHAIN=auto "$GO_BIN" test -race ./... )
( cd worker-go && GOTOOLCHAIN=auto "$GO_BIN" vet ./... )

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/worker-t02-go.XXXXXXXX")"
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

SOURCE_COMMIT="$(git rev-parse HEAD)"
TEST_VERSION=0.0.0
build_one() {
  os="$1"; arch="$2"; suffix="$3"; ext="$4"; arm="${5:-}"
  dest="$TEMP_DIR/bot-report-worker-$os-$suffix$ext"
  echo "[T2] PC cross-build: $os/$arch ($suffix); native target execution NOT_TESTED unless linux/amd64"
  ( cd worker-go && CGO_ENABLED=0 GOTOOLCHAIN=auto GOOS="$os" GOARCH="$arch" GOARM="$arm" "$GO_BIN" build \
    -buildvcs=false -trimpath \
    -ldflags "-s -w -X main.version=$TEST_VERSION -X main.commit=$SOURCE_COMMIT" \
    -o "$dest" . )
  [ -s "$dest" ] || { echo "[T2] empty build: $dest" >&2; exit 1; }
  first="$(openssl dgst -sha256 "$dest" | awk '{print $NF}')"
  ( cd worker-go && CGO_ENABLED=0 GOTOOLCHAIN=auto GOOS="$os" GOARCH="$arch" GOARM="$arm" "$GO_BIN" build \
    -buildvcs=false -trimpath \
    -ldflags "-s -w -X main.version=$TEST_VERSION -X main.commit=$SOURCE_COMMIT" \
    -o "$dest.second" . )
  second="$(openssl dgst -sha256 "$dest.second" | awk '{print $NF}')"
  [ "$first" = "$second" ] || { echo "[T2] non-reproducible build: $os/$arch" >&2; exit 1; }
  echo "[T2] deterministic build PASS: $os/$arch sha256=$first"
}
build_one linux amd64 amd64 ''
build_one linux arm64 arm64 ''
build_one linux 386 386 ''
build_one linux arm armv7 '' 7
build_one darwin amd64 amd64 ''
build_one darwin arm64 arm64 ''
build_one windows amd64 amd64 .exe
build_one windows arm64 arm64 .exe

if [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]; then
  OUTPUT="$("$TEMP_DIR/bot-report-worker-linux-amd64" version)"
  case "$OUTPUT" in "systemtd $TEST_VERSION commit=$SOURCE_COMMIT runtime="*) ;;
    *) echo "[T2] locally built Go binary returned unexpected version/commit" >&2; exit 1;;
  esac
  echo "[T2] PASS: PC Linux/amd64 executable embeds exact full source SHA"
else
  echo "[T2] NOT_TESTED: Linux/amd64 native execution (host differs)"
fi
echo "[T2] NOT_TESTED: Windows native installers, macOS native installers, privileged systemd"
echo "[T2] PASS: Go test/race/vet and reproducible eight-target cross-build; no release signing/publication"
