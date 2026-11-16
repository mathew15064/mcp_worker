#!/usr/bin/env bash
# Local-only source/target OCI identity check. Never pulls, pushes or publishes.
set -euo pipefail
cd "$(dirname "$0")/.."
deny() { printf 'OCI_LOCAL_DENIED: %s\n' "$1" >&2; exit 1; }
[[ "$#" -eq 2 ]] || deny 'usage: verify-oci-image-local.sh LOCAL_IMAGE_TAG standalone'
image="$1"
flavor="$2"
[[ "$flavor" == standalone ]] || deny 'only standalone image flavor is supported'
command -v docker >/dev/null && docker info >/dev/null 2>&1 || deny 'local Docker daemon unavailable'
[[ -z "$(git status --porcelain)" ]] || deny 'dirty source cannot be identified by committed SHA/TREE alone'
sha="$(git rev-parse HEAD)"
tree="$(git rev-parse HEAD^{tree})"
node_base='node:22.22.3-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd'
go_base='golang:1.26.10-alpine@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696'
docker image inspect "$image" >/dev/null 2>&1 || deny 'local image absent; do not pull'
label() { docker image inspect --format "{{index .Config.Labels \"$1\"}}" "$image"; }
[[ "$(label org.opencontainers.image.revision)" == "$sha" ]] || deny 'revision label != exact PC HEAD'
[[ "$(label org.bot-report.source-tree)" == "$tree" ]] || deny 'tree label != exact PC HEAD tree'
[[ "$(label org.bot-report.node-base)" == "$node_base" ]] || deny 'Node 22 pinned base label mismatch'
[[ "$(label org.bot-report.go-base)" == "$go_base" ]] || deny 'Go 1.26.10 pinned builder label mismatch'
[[ "$(label org.bot-report.image-flavor)" == "$flavor" ]] || deny 'standalone image flavor mismatch'
[[ "$(label org.bot-report.build-origin)" == 'local-pc-only' ]] || deny 'missing local PC provenance'
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/amd64 ]] || deny 'image not linux/amd64'
[[ "$(docker image inspect --format '{{json .Config.Cmd}}' "$image")" == '["node","dist/src/server.js"]' ]] || deny 'runtime command differs'
[[ "$(docker image inspect --format '{{json .Config.Healthcheck.Test}}' "$image")" == *healthz* ]] || deny 'healthcheck missing'
[[ "$(docker image inspect --format '{{.Config.User}}' "$image")" == node ]] || deny 'standalone runtime must start as node'
[[ "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$image")" == '["docker-entrypoint.sh"]' ]] || deny 'standalone entrypoint mismatch'

# Runtime probes, not only self-declared labels, with no network or host mounts.
runtime="$(docker run --rm --pull=never --network=none --read-only --entrypoint node "$image" --version)" || deny 'Node executable probe failed'
[[ "$runtime" == v22.* ]] || deny 'runtime Node is not v22'
worker="$(docker run --rm --pull=never --network=none --read-only --entrypoint /app/dist/worker/bin/bot-report-worker-linux-amd64 "$image" version)" || deny 'Worker executable probe failed'
[[ "$worker" == "worker_mcp 2.3.4 commit=$sha runtime="* ]] || deny 'Worker binary embeds wrong source commit/version'
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || deny 'invalid local image config ID'
printf 'OCI_LOCAL_PASS flavor=%s revision=%s tree=%s node=%s go_builder=%s image_id=%s\n' "$flavor" "$sha" "$tree" "$runtime" "$go_base" "$image_id"
echo 'OCI_REGISTRY_MANIFEST_DIGEST=NOT_TESTED (local image ID is not a published digest)'
echo 'OCI_PROVENANCE_LIMIT: labels and local binaries are not a signed supply-chain attestation'
