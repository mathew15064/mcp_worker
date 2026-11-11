#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
GO_BIN="${GO_BIN:-go}"
VERSION="${VERSION:-2.3.4}"
COMMIT="${COMMIT:-$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)}"
OUT="$ROOT/worker/bin"
mkdir -p "$OUT"
rm -f "$OUT"/bot-report-worker-linux-* "$OUT"/bot-report-worker-darwin-* "$OUT"/bot-report-worker-windows-*.exe "$OUT"/SHA256SUMS "$OUT"/SHA256SUMS.sig "$OUT"/WORKER_RELEASE

build() {
  os="$1"
  arch="$2"
  suffix="$3"
  ext="${4:-}"
  echo "[worker-build] $os/$arch -> bot-report-worker-$os-$suffix$ext"
  (cd "$ROOT/worker-go" && env CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" "$GO_BIN" build \
    -buildvcs=false \
    -trimpath \
    -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT" \
    -o "$OUT/bot-report-worker-$os-$suffix$ext" .)
  [ "$os" = windows ] || chmod 0755 "$OUT/bot-report-worker-$os-$suffix$ext"
}

build linux amd64 amd64
build linux arm64 arm64
build linux 386 386

echo "[worker-build] linux/arm -> bot-report-worker-linux-armv7"
(cd "$ROOT/worker-go" && env GOARM=7 CGO_ENABLED=0 GOOS=linux GOARCH=arm "$GO_BIN" build \
  -buildvcs=false \
  -trimpath \
  -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT" \
  -o "$OUT/bot-report-worker-linux-armv7" .)
chmod 0755 "$OUT/bot-report-worker-linux-armv7"

build darwin amd64 amd64
build darwin arm64 arm64
build windows amd64 amd64 .exe
build windows arm64 arm64 .exe

( cd "$OUT" && printf 'version=%s\ncommit=%s\n' "$VERSION" "$COMMIT" > WORKER_RELEASE && sha256sum bot-report-worker-* WORKER_RELEASE > SHA256SUMS )
echo "[worker-build] manifest: $OUT/SHA256SUMS"
