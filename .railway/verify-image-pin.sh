#!/usr/bin/env bash
# READ-ONLY PC PREFLIGHT. Verifies syntax and local-image/source consistency,
# NOT remote registry reachability, manifest equivalence or owner approval.
set -euo pipefail
cd "$(dirname "$0")/.."
ref="${1:-}"
sha="${2:-}"
local_image="${3:-}"
deny() { echo "IMAGE_PIN_DENIED: $1" >&2; exit 1; }
[[ "$ref" =~ ^[a-z0-9][a-z0-9._:-]*(/[a-z0-9][a-z0-9._-]*)+@sha256:[a-f0-9]{64}$ ]] || deny 'full registry/repository@sha256:<64 lower hex> required'
digest="${ref##*@sha256:}"
[[ "$digest" != "$(printf '0%.0s' {1..64})" ]] || deny 'zero digest is a placeholder'
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || deny '40-hex source commit required'
[[ "$sha" == "$(git rev-parse HEAD)" ]] || deny 'source SHA not this isolated worktree HEAD'
[[ -n "$local_image" ]] || deny 'local PC-tested image tag required'
label="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$local_image" 2>/dev/null)" || deny 'local image not available'
[[ "$label" == "$sha" ]] || deny 'local image source revision differs'
echo 'IMAGE_PIN_FORMAT_AND_LOCAL_PROVENANCE_PASS'
echo 'REGISTRY_DIGEST_NOT_VERIFIED: this does NOT check a live manifest or that its layers equal the local PC image'
echo 'OWNER_APPROVAL_NOT_VERIFIED: no IaC apply/deploy/template or registry upload is authorized'
