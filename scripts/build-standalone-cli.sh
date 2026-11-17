#!/bin/sh
# Local development build only. Not a signed public release or installer.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/worker/dev-bin}"
mkdir -p "$OUT"
(
  cd "$ROOT/worker-go"
  CGO_ENABLED=0 go build -trimpath -buildvcs=false \
    -ldflags "-X main.version=dev -X main.commit=$(git -C "$ROOT" rev-parse HEAD)" \
    -o "$OUT/mcp_worker" .
)
echo "Development CLI: $OUT/mcp_worker"
"$OUT/mcp_worker" version
