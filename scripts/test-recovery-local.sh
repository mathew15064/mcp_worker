#!/usr/bin/env bash
# T4 local-only acceptance. No CI, production database, remote Railway or deployment.
set -euo pipefail
if [[ "${T04_LOCAL_TEST_ONLY:-}" != 1 ]]; then
  echo "Refused: explicitly set T04_LOCAL_TEST_ONLY=1 for disposable PC tests" >&2
  exit 2
fi
if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "Refused: T4 recovery verification must run on a local PC, never CI" >&2
  exit 2
fi
if [[ -n "${DATABASE_PATH:-}" || -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ]]; then
  echo "Refused: do not launch local fixtures with a preconfigured database/volume" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
if [[ "$(git branch --show-current)" != "work/oneclick-unblock-t4" ]] ||
   ! git merge-base --is-ancestor ae588a1a56f2561ca2323457463e5b9e203de509 HEAD; then
  echo "Refused: use the isolated T4 worktree based on the pinned SHA" >&2
  exit 2
fi
for command in node npm openssl go; do
  command -v "$command" >/dev/null || { echo "Missing local tool: $command" >&2; exit 2; }
done
echo "T04_LOCAL_CHECK: npm installation, lint, typecheck, build"
npm ci --no-audit --no-fund
npm run lint
npm run typecheck
npm run build
echo "T04_LOCAL_CHECK: two Node instances, WAL backup, restore and failure gates"
node --test --test-concurrency=1 \
  dist/tests/railway-disaster-recovery.test.js \
  dist/tests/railway-backup-encryption.test.js \
  dist/tests/railway-instance-isolation.test.js
echo "T04_LOCAL_CHECK: two real Go workers, independent identities and command policy"
BOT_REPORT_W3_T04_GO_E2E=1 \
  node --test --test-concurrency=1 dist/tests/railway-instance-isolation-go.test.js
if [[ "${T04_SKIP_DOCKER:-0}" == 1 ]]; then
  echo "T04_DOCKER_NOT_TESTED: explicitly skipped; NOT a full local PASS"
else
  command -v docker >/dev/null || { echo "Docker required unless T04_SKIP_DOCKER=1" >&2; exit 2; }
  docker info >/dev/null
  image="${T04_DOCKER_IMAGE:-t04-railway-sandbox:local}"
  if [[ "$image" != "t04-railway-sandbox:local" ]]; then
    echo "Refused: only T4 disposable image tag is allowed" >&2
    exit 2
  fi
  echo "T04_LOCAL_CHECK: build standalone Docker image on this PC"
  docker build -f Dockerfile.railway -t "$image" .
  echo "T04_LOCAL_CHECK: isolate Docker volumes and verify readonly refusal"
  W3_SANDBOX_ONLY=1 bash scripts/verify-railway-docker-isolation.sh "$image"
  echo "T04_LOCAL_CHECK: authenticated offsite retrieval across five disposable Docker volumes"
  T04_LOCAL_TEST_ONLY=1 bash scripts/test-t4-offsite-docker.sh "$image"
fi
echo "T04_LOCAL_TESTS_COMPLETE: local-only evidence; Railway live NOT_TESTED"
