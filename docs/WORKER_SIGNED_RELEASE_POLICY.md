# Signed Go Worker — local-only release candidate and trust-root policy (T2)

**Status: NO-GO.** No production signing key, approved version/commit, or approved
release artifacts exist. Railway routes `/worker/install*` and `/worker/dist/*`
must continue to return HTTP 503 `WORKER_SIGNED_RELEASE_PENDING`.
This document defines a future owner-operated process; it authorizes **no**
public tag, GitHub Release, installer, binary, deployment or key creation.

## Trust model and enforced invariants

- The owner independently authenticates the installer script and its embedded
  `APPROVED_WORKER_RELEASE` pin. An installer downloaded from an untrusted
  endpoint is **not** a root of trust, even if it verifies its subsequent
  artifacts. Transport HTTPS is required for public distribution.
- Installer artifact downloads require HTTPS without protocol-downgrade
  redirects; only disposable loopback verification fixtures permit HTTP. The
  Windows script disallows redirects. The release origin must be separately
  reviewed and controlled by the owner.
- The reviewed pin supplies **all** of: strict `x.y.z` version, 12–40 lowercase
  hex commit prefix, base64-encoded PEM RSA public key, and (only for an explicit
  rotation) `previousPublicKeySha256`. None is configurable by an environment
  trust-key override. Missing pins fail closed. Each semantic version component
  has no leading zero except `0`. Git review must verify the commit prefix
  resolves unambiguously to the approved immutable source.
- The detached RSA/SHA-256 signature authenticates the **exact bytes** of
  `SHA256SUMS`. That manifest authenticates `WORKER_RELEASE` (exact
  `version=...\ncommit=...\n`) and every platform binary. Installers verify
  signature, checksum, metadata and chosen binary before installation. The
  **executed downloaded binary** must print a single-line identity with
  `systemtd x.y.z commit=<sha> runtime=...`, matching signed metadata before
  replacement; merely exiting successfully on `version` is insufficient.
  The release signer requires a canonical manifest containing exactly eight
  binaries and `WORKER_RELEASE` (nine entries), with no duplicate, extra or
  symbolic-link artifacts. No signing workflow is permitted in public CI.
- After first successful install, the installer records the SPKI DER SHA-256
  fingerprint in `release-key-sha256` alongside `release-version` and
  `release-commit`. Subsequent releases must match that key, must not move
  backward in semantic version, and must not reuse a version for a different
  commit. Missing/corrupt key records fail closed; migration requires a
  dedicated reviewed procedure rather than silent adoption.
- An **authorized one-way key rotation** requires a newly reviewed installer
  pin signed by the **new** key, plus the exact **old** SPKI SHA-256 in
  `previousPublicKeySha256` and a strictly **higher** release version.
  Any other key replacement fails; after rotation, the previous key is not
  trusted again automatically. Changing the public key without this explicit
  owner-reviewed link is **unauthorized replacement**, not rotation.
  Key compromise is a security incident: revoke distribution, investigate
  identity and artifacts, and obtain a separate owner-approved recovery plan.
- Unix installer semantic versions are compared as exact decimal-component
  strings, avoiding floating-point rounding of large version components.
  Manual rollback (even with a locally saved checksum) remains forbidden.
  Automatic restoration of the previous binary following failed start is
  operational recovery only; it does not authorize installation of an older
  signed release. The recorded version/commit/trust root remain unchanged on
  failed replacement. A deliberate downgrade requires separate security
  review, a new policy and a new signed migration path.
- An approved release signature is **necessary, not sufficient**: independent
  review must still verify source provenance, built binary behavior, HTTPS
  origin, artifact inventory, native lifecycle tests and release owner consent.

## Key custody and rotation approval

The **owner**, not CI or a coding agent, selects and holds the production
private key in an offline signer/HSM or access-controlled signing host.
Never commit a private key, store it in the repository/worktree, expose it in
Docker build contexts, Actions variables/logs, or upload it as an Actions
artifact. The signer accepts only an absolute path to a regular, non-symlink
RSA private-key file **outside** the checkout with permission `0400` or
`0600`. Do not copy the key to a CI runner or paste key contents into logs,
PR descriptions or chat. Use an owner-controlled independent channel to
approve the SPKI fingerprint and exact public key bytes before any pin change.

For a proposed rotation, record an owner-approved change ticket documenting
old and new fingerprints, reason, custodians, target version/commit, artifact
digests, tester results, incident/rollback plan, and **two distinct approvals**
(key custodian and release reviewer). A different new key without the approved
old fingerprint is denied by installers. Do not accept an environment variable,
HTTP header, user input or self-signed manifest as authority to change roots.

## Reproducible offline RC procedure — **requires prior owner authorization**

1. Check out exactly the owner-reviewed immutable 40-character commit in an
   isolated, clean workspace; confirm `git rev-parse HEAD`,
   `git status --porcelain` (empty), commit ancestry and review of source
   dependencies. Pick a unique never-reused semver without leading zeros,
   and independently record the first 12 or more characters of the commit.
   The signer checks the approved commit prefix against `git rev-parse HEAD`,
   refuses dirty sources and symlink manifest/metadata. Do **not** create a tag.
2. Build locally using the approved exact values, e.g.
   `VERSION=X.Y.Z COMMIT=123456789abc ./scripts/build-worker-go.sh`
   (replace examples with approved real values). Check
   `cat worker/bin/WORKER_RELEASE`, verify the commit matches the checked-out
   source, `(cd worker/bin && sha256sum -c SHA256SUMS)`, and inspect all nine
   manifest entries. Execute `worker/bin/bot-report-worker-linux-amd64 version`
   and compare **both** embedded version/commit to metadata. Independently
   verify macOS/Windows binary version output in native environments.
3. Run `npm ci --prefer-offline --no-audit --no-fund` **on the PC**,
   then `./scripts/test-signed-worker-local.sh`. This runs Node typecheck,
   build, loopback signed-fixture/negative tests, Go tests with a Go >=1.24
   toolchain, and a temporary local Linux/amd64 Go build with an embedded
   test-only identity. Optionally set `SIGNED_WORKER_CROSS_BUILD=1` to
   cross-compile macOS and Windows binaries **only into a deleted temporary
   directory**. A cross-build is not a native installer execution. Run all
   other required Node/integration and native installer tests on each real
   target OS **locally** before release; otherwise mark each unavailable
   target **NOT_TESTED**, never PASS. Store private local test logs and hashes;
   do not execute, rely on or upload anything via GitHub Actions/CI.
4. In the owner-only signing environment, obtain the private key securely
   **outside** the repository, verify permission `0600` or `0400`, and run
   `WORKER_RELEASE_EXPECTED_VERSION=X.Y.Z WORKER_RELEASE_EXPECTED_COMMIT=123456789abc WORKER_RELEASE_EXPECTED_PUBLIC_KEY_SHA256=<independently-approved-64-char-SPKI-sha256> ./scripts/sign-worker-manifest.sh /absolute/outside-source/private.pem`.
   The signer rejects stale signatures and refuses any private key whose derived
   SPKI SHA-256 differs from the separately approved fingerprint. Sign only
   after a fresh unsigned build. The three expected fields are manual
   owner-provided **confirmation inputs**, not a substitute for approval.
   This is an offline manual action, **never** an Actions job.
5. Independently derive and out-of-band compare the public-key fingerprint:
   `openssl pkey -pubin -in public.pem -outform DER -out public.der` followed
   by `sha256sum public.der`. Validate
   `openssl dgst -sha256 -verify public.pem -signature worker/bin/SHA256SUMS.sig worker/bin/SHA256SUMS`.
   Recheck all hashes after signing. Do not upload the signature, key or
   binaries while release approval is pending.
6. Present the owner a review packet: exact source SHA, release version,
   public-key SPKI SHA-256, nine artifact hashes, manifest signature digest,
   local test command/log digests, explicit Linux/macOS/Windows native results
   (including NOT_TESTED), supply-chain provenance, distribution HTTPS address,
   rotation record (if any), and maintenance/restore procedure.
   The owner explicitly approves the exact tuple and pinned installer code,
   then separately approves a narrowly scoped publication/deployment change.
   The existing unconditional Railway HTTP 503 must **not** be removed by
   this task or implicitly by a key update.

## Read-only status contract for Admin/onboarding consumers (T5)

Import `railwayWorkerDistributionBlocked(): boolean` from
`src/services/workerReleaseGate.ts` to display **Railway signed release
pending**. A `true` value is a hard **NO-GO** and must suppress public
installation instructions; it is not an installer-token or signing API. On
non-Railway local development this function can be `false` even when the
shipped installer has empty release pins and refuses execution: consumers
must **never** infer production approval or a verified signed artifact solely
from `false`. The HTTP routes remain the authoritative boundary and emit
503 / `WORKER_SIGNED_RELEASE_PENDING` on Railway until the separately
approved source-controlled release and distribution change. No runtime
environment variable authorizes a key, trust-root change, or public release.

## Verification and separation of duties

For this T2, **all verification is performed on the local PC**. GitHub
Actions/CI is excluded: do not trigger jobs, use hosted runners, collect
Actions artifacts or use Actions as approval evidence. The dedicated
`./scripts/test-signed-worker-local.sh` operates without production secrets,
uses disposable in-process cryptographic fixtures on loopback, and deletes
all temporary Go test binaries. It refuses to run if a signature already
exists in `worker/bin` and never publishes a release.

On the present **Linux/amd64 PC**, the shell installer lifecycle with a
**test-only signed stub** and a separate temporary real Go binary identity
check can be marked PASS after successful runs. Actual systemd service-mode
installation and recovery require a privileged disposable Linux host before
release; these are **NOT_TESTED** in this verifier.
Cross-compiling macOS and Windows variants (when enabled) establishes only
compilation, not native execution. Until actually exercised on those operating
systems with local test evidence, macOS/Windows native installer and service
lifecycle results are **NOT_TESTED**, not PASS; production authorization remains
blocked. The signer currently uses GNU `stat` and `sha256sum` on Linux; do
not assume it is portable to a macOS signing host without separate validation.

Review local logs, `git ls-files`, build contexts and artifact inventories for
private keys or unapproved binaries. Automated absence checks cannot prove a
signing host is clean; require manual owner review and out-of-band trust-root
approval before any release. Never store signing material or test artifacts in
public repositories or artifact services.

### Owner approval record (currently all pending)

| Gate | Required evidence | Status |
| --- | --- | --- |
| Immutable source & complete provenance | Reviewed 40-char SHA, unambiguous prefix, native version output | PENDING |
| Key custody | Owner-held external RSA key, SPKI fingerprint independently verified | PENDING |
| Root policy | Old/new fingerprint and separate rotation approval if applicable | PENDING |
| Signed package | Nine hashes, detached signature, independent verification | PENDING |
| Security | Local Node and Go verification, three-OS native negative/lifecycle tests, failure recovery | PENDING |
| Distribution & ops | HTTPS origin, isolation, owner recovery runbook and explicit release decision | PENDING |
| Publish authorization | Separate explicit owner approval; no automatic release or deployment | PENDING |

**Current decision: NO-GO** — no key, public binary, tag, Release or production
installer can be published based on this document alone.
