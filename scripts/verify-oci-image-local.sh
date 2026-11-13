#!/usr/bin/env bash
# Read-only image identity check against the exact committed PC checkout.
# Docker local image ID / RepoDigests can reflect a local OCI manifest index;
# neither demonstrates a published remote registry manifest digest.
set -euo pipefail
cd "$(dirname "$0")/.."
image="${1:?usage: verify-oci-image-local.sh LOCAL_IMAGE_TAG}"
source_sha="$(git rev-parse HEAD)"
tree_sha="$(git rev-parse HEAD^{tree})"
deny() { echo "OCI_LOCAL_DENIED: $1" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || deny 'source worktree not clean; commit before provenance build'
actual_sha="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" || deny 'local Docker image absent'
actual_tree="$(docker image inspect --format '{{index .Config.Labels "org.bot-report.source-tree"}}' "$image")"
[[ "$actual_sha" == "$source_sha" ]] || deny 'image revision label differs from PC source SHA'
[[ "$actual_tree" == "$tree_sha" ]] || deny 'image source tree label differs from exact committed files'
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/amd64 ]] || deny 'image is not Linux amd64'
[[ "$(docker image inspect --format '{{.Config.User}}' "$image")" == root ]] || deny 'root-owned Railway mount requires initializer before dropping to UID1000'
[[ "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$image")" == '["docker-entrypoint-railway.sh"]' ]] || deny 'entrypoint differs'
[[ "$(docker image inspect --format '{{json .Config.Cmd}}' "$image")" == '["node","dist/src/server.js"]' ]] || deny 'runtime command differs'
[[ "$(docker image inspect --format '{{json .Config.Healthcheck.Test}}' "$image")" == *healthz* ]] || deny 'healthcheck missing'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.bot-report.build-origin"}}' "$image")" == local-pc-only ]] || deny 'missing PC build-origin label'
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || deny 'unrecognized local image config identity'
repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$image")"
echo "OCI_LOCAL_PASS source_sha=$source_sha tree_sha=$tree_sha image_id=$image_id os=linux/amd64"
echo "OCI_LOCAL_REPO_DIGEST_OBSERVED=$repo_digests"
echo 'OCI_LOCAL_ID_NOTE: Docker BuildKit/containerd may use a local OCI manifest-list ID, not the image config SHA'
echo "OCI_REGISTRY_MANIFEST_DIGEST=NOT_AVAILABLE_UNTIL_OWNER_APPROVED_REGISTRY_PUBLISH"
echo 'OCI_RUNTIME_NOTE: image config starts root for mount chown, real PID1 UID1000 checked by Docker integration test'
