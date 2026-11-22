#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
GO_BIN="${GO_BIN:-go}"
OUT="$ROOT/worker/bin"
case "${1:-}" in ''|--runtime-only) ;; *) echo 'Usage: VERSION=x.y.z COMMIT=full40hex build-worker-go.sh [--runtime-only]' >&2; exit 2 ;; esac

if [ "${1:-}" = --runtime-only ]; then
  # Compatibility with the separate, pinned production Docker runtime.
  # This is NOT a public signed release build.
  VERSION="${VERSION:-2.3.4}"
  COMMIT="${COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf unknown)}"
else
  # A release candidate must be bound to exactly one reviewed immutable Git commit.
  VERSION="${VERSION:-}"
  COMMIT="${COMMIT:-}"
  printf '%s' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$' || {
    echo '[worker-build] release VERSION=x.y.z is required' >&2; exit 2;
  }
  printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || {
    echo '[worker-build] release COMMIT must be full 40-character lowercase Git SHA' >&2; exit 2;
  }
  [ "$COMMIT" = "$(git -C "$ROOT" rev-parse --verify HEAD)" ] || {
    echo '[worker-build] source HEAD does not match approved release commit' >&2; exit 2;
  }
  [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=normal)" ] || {
    echo '[worker-build] release requires a clean source checkout' >&2; exit 2;
  }
  PACKAGE_VERSION="$(node -p "require('$ROOT/package.json').version")"
  [ "$PACKAGE_VERSION" = "$VERSION" ] || {
    echo "[worker-build] release version $VERSION differs from package.json $PACKAGE_VERSION" >&2; exit 2;
  }
  [ -z "$(git -C "$ROOT" tag -l "v$VERSION")" ] || {
    echo "[worker-build] immutable v$VERSION tag already exists locally" >&2; exit 2;
  }
fi

mkdir -p "$OUT"
# A signing or distribution directory must never be silently overwritten.
if [ "${1:-}" != --runtime-only ]; then
  for file in "$OUT"/worker_mcp-* "$OUT"/SHA256SUMS "$OUT"/SHA256SUMS.sig "$OUT"/WORKER_RELEASE; do
    [ ! -e "$file" ] && [ ! -L "$file" ] || {
      echo "[worker-build] existing release artifact refused: $file" >&2; exit 2;
    }
  done
else
  [ ! -e "$OUT/SHA256SUMS.sig" ] || {
    echo '[worker-build] signed artifacts present; runtime-only build refused' >&2; exit 2;
  }
fi

build() {
  os="$1"
  arch="$2"
  suffix="$3"
  ext="${4:-}"
  echo "[worker-build] $os/$arch -> worker_mcp-$os-$suffix$ext"
  (cd "$ROOT/worker-go" && env CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" "$GO_BIN" build \
    -buildvcs=false \
    -trimpath \
    -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT" \
    -o "$OUT/worker_mcp-$os-$suffix$ext" .)
  [ "$os" = windows ] || chmod 0755 "$OUT/worker_mcp-$os-$suffix$ext"
}

build linux amd64 amd64
if [ "${1:-}" = --runtime-only ]; then
  echo '[worker-build] runtime-only: skip cross-OS signed-release artifacts'
  exit 0
fi
build linux arm64 arm64
build linux 386 386

echo "[worker-build] linux/arm -> worker_mcp-linux-armv7"
(cd "$ROOT/worker-go" && env GOARM=7 CGO_ENABLED=0 GOOS=linux GOARCH=arm "$GO_BIN" build \
  -buildvcs=false \
  -trimpath \
  -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT" \
  -o "$OUT/worker_mcp-linux-armv7" .)
chmod 0755 "$OUT/worker_mcp-linux-armv7"

build darwin amd64 amd64
build darwin arm64 arm64
build windows amd64 amd64 .exe
build windows arm64 arm64 .exe

( cd "$OUT" && printf 'version=%s\ncommit=%s\n' "$VERSION" "$COMMIT" > WORKER_RELEASE && sha256sum worker_mcp-* WORKER_RELEASE > SHA256SUMS )
echo "[worker-build] manifest: $OUT/SHA256SUMS"
