#!/usr/bin/env bash
# Local read-only release provenance preflight; never grants owner approval.
set -euo pipefail
cd "$(dirname "$0")/.."
sha="${1:-}"
branch="${2:-}"
fail() { printf 'RELEASE_PIN_DENIED: %s\n' "$1" >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'complete lowercase 40-character SHA required'
[[ "$sha" != 0000000000000000000000000000000000000000 ]] || fail 'zero SHA is not a release'
[[ "$sha" != 9a817baabdaeb6a019083252dac6ca5077257474 ]] || fail 'original review SHA is prohibited'
[[ "$sha" != ae588a1a56f2561ca2323457463e5b9e203de509 ]] || fail 'unapproved local baseline SHA is prohibited'
[[ "$branch" =~ ^release/[a-zA-Z0-9][a-zA-Z0-9._/-]*$ ]] || fail 'release/* branch required'
[[ "$branch" != *OWNER_APPROVAL_REQUIRED* ]] || fail 'placeholder branch is not an approval'
git cat-file -e "${sha}^{commit}" 2>/dev/null || fail 'commit not present in local object store'
# An origin tracking ref can be stale; this is only an offline candidate check.
ref="refs/remotes/origin/$branch"
git show-ref --verify --quiet "$ref" || fail 'origin release ref is missing locally; remote reachability NOT_VERIFIED'
actual="$(git rev-parse --verify "$ref^{commit}")" || fail 'invalid tracked release ref'
[[ "$actual" == "$sha" ]] || fail 'release branch tip differs from approved SHA'
git merge-base --is-ancestor "$sha" "$ref" || fail 'release SHA is not an ancestor'
echo 'RELEASE_PIN_OFFLINE_PASS: locally cached origin release ref equals SHA'
echo 'RELEASE_PIN_REMOTE_NOT_VERIFIED: separately verify live GitHub source reachability, owner approval, repository protections and deploy commit; this script performs no network request'
