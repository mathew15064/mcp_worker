#!/usr/bin/env bash
# Operator-only, run on the Docker host. Do not mount the Docker socket in the gateway.
set -euo pipefail
umask 077

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <gateway-container> <active-user-id> [hosted-worker-image]" >&2
  exit 2
fi

gateway="$1"
user_id="$2"
image="${3:-mcpw-hosted-worker:v3}"

if [[ ! "$user_id" =~ ^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "A valid usr_<UUID> is required." >&2
  exit 2
fi
command -v docker >/dev/null
docker container inspect "$gateway" >/dev/null
docker image inspect "$image" >/dev/null

suffix="${user_id#usr_}"
network="mcpw3-user-${suffix}"
name="mcpw3-worker-${suffix}"
profile="hosted_${suffix}"
home="mcpw3-home-${suffix}"
workspace="mcpw3-workspace-${suffix}"
gateway_alias="mcpw3-gateway"

if docker container inspect "$name" >/dev/null 2>&1; then
  echo "Worker container $name already exists; refusing to overwrite identity." >&2
  exit 1
fi

if ! docker network inspect "$network" >/dev/null 2>&1; then
  docker network create --driver bridge --internal \
    --label mcp_worker.hosted=true --label "mcp_worker.owner=$user_id" "$network" >/dev/null
fi
if [[ "$(docker network inspect --format '{{.Internal}}' "$network")" != true ]]; then
  echo "Worker network must be internal-only." >&2
  exit 1
fi
if ! docker inspect --format '{{json .NetworkSettings.Networks}}' "$gateway" | grep -Fq '"'"$network"'"'; then
  docker network connect --alias "$gateway_alias" "$network" "$gateway"
fi

for volume in "$home" "$workspace"; do
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume create --label mcp_worker.hosted=true \
      --label "mcp_worker.owner=$user_id" "$volume" >/dev/null
  fi
done

docker_flags=(
  --network "$network"
  --user 10001:10001
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges
  --pids-limit 128
  --memory 384m
  --cpus 0.6
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777
  --mount "type=volume,source=$home,target=/home/worker"
  --mount "type=volume,source=$workspace,target=/workspace"
)

# One-time enrollment stays inside the trusted host process; never store it
# in a Docker environment variable, image layer, or shell trace.
token="$(docker exec "$gateway" node dist/scripts/issue-hosted-enrollment.js "$user_id")"
if [[ "$token" != br_enroll_* ]]; then
  echo "Gateway did not issue a valid one-time enrollment token." >&2
  exit 1
fi

login_output="$(printf '%s\n' "$token" | docker run --rm -i \
  "${docker_flags[@]}" \
  -e "HOSTED_NAME=Hosted ${suffix}" -e "HOSTED_PROFILE=$profile" \
  --entrypoint /bin/sh "$image" -ec '
    IFS= read -r enrollment
    exec worker_mcp login --server http://mcpw3-gateway \
      --insecure-http --token "$enrollment" \
      --name "$HOSTED_NAME" --profile "$HOSTED_PROFILE" \
      --roots /workspace --no-start
  ')"
unset token
worker_id="$(printf '%s\n' "$login_output" | sed -nE 's/^.*enrolled worker=.* id=([0-9a-f-]{36}).*$/\1/p' | head -1)"
if [[ ! "$worker_id" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "Worker enrollment did not provide a valid identity." >&2
  exit 1
fi

docker run -d --name "$name" --restart unless-stopped \
  --label mcp_worker.hosted=true --label "mcp_worker.owner=$user_id" \
  --label "mcp_worker.worker_id=$worker_id" \
  "${docker_flags[@]}" "$image" run >/dev/null

# Attest observable Docker isolation before allowing any terminal tool access.
[[ "$(docker inspect --format '{{.State.Running}}' "$name")" == true ]]
[[ "$(docker inspect --format '{{.HostConfig.Privileged}}' "$name")" == false ]]
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$name")" == true ]]
[[ "$(docker inspect --format '{{.Config.User}}' "$name")" == '10001:10001' ]]
[[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$name")" == "$network" ]]
[[ "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$name")" == '["ALL"]' ]]
[[ "$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$name")" == '["no-new-privileges"]' ]]
mounts="$(docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Destination}};{{end}}' "$name")"
[[ "$mounts" == *'volume:/home/worker;'* ]]
[[ "$mounts" == *'volume:/workspace;'* ]]
[[ "$(tr ';' '\n' <<< "$mounts" | grep -c '^volume:')" -eq 2 ]]

# A foreground Worker runs as container PID 1; the standalone CLI status
# helper intentionally treats PID 1 as special. Attest broker presence instead.
attested=0
for _ in {1..20}; do
  if docker exec "$gateway" node dist/scripts/attest-hosted-worker.js "$user_id" "$worker_id" >/dev/null 2>&1; then
    attested=1
    break
  fi
  sleep 1
done
if [[ "$attested" -ne 1 ]]; then
  docker exec "$gateway" node dist/scripts/attest-hosted-worker.js "$user_id" "$worker_id"
  exit 1
fi
printf 'HOSTED_WORKER_READY user=%s worker=%s container=%s profile=%s network=%s\n' \
  "$user_id" "$worker_id" "$name" "$profile" "$network"
printf 'Execution remains disabled until operator enables hosted.execution.enabled after E2E verification.\n'
