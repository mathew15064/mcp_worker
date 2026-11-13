#!/usr/bin/env bash
# LEGACY GITHUB-SOURCE CHECK RETIRED. A GitHub source triggers Railway builds.
# This guard never approves a release or deploy and always fails closed.
set -euo pipefail
echo 'GITHUB_SOURCE_DENIED: use a PC-built, tested, owner-approved registry manifest digest via Docker Image source; see verify-image-pin.sh' >&2
exit 1
