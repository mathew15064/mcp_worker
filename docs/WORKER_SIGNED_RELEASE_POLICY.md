# Signed Go Worker — release candidate and trust-root policy (W3-T02)

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
- The reviewed pin supplies **all** of: strict `x.y.z` version, 12–40 lowercase
  hex commit prefix, base64-encoded PEM RSA public key, and (only for an explicit
  rotation) `previousPublicKeySha256`. None is configurable by an environment
  trust-key override. Missing pins fail closed. Git review must verify the
  commit prefix resolves unambiguously to the approved immutable source.
- The detached RSA/SHA-256 signature authenticates the **exact bytes** of
  `SHA256SUMS`. That manifest authenticates `WORKER_RELEASE` (exact
  `version=...\ncommit=...\n`) and every platform binary. Installers verify
  signature, checksum, metadata and chosen binary before installation.
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
- Manual rollback (even with a locally saved checksum) remains forbidden.
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
   dependencies. Pick a unique never-reused semver, and independently record
   the first 12 or more characters of the commit. Do **not** create a tag.
2. Build locally using the approved exact values, e.g.
   `VERSION=X.Y.Z COMMIT=123456789abc ./scripts/build-worker-go.sh`
   (replace examples with approved real values). Check
   `cat worker/bin/WORKER_RELEASE`, verify the commit matches the checked-out
   source, `(cd worker/bin && sha256sum -c SHA256SUMS)`, and inspect all nine
   manifest entries. Execute `worker/bin/bot-report-worker-linux-amd64 version`
   and compare **both** embedded version/commit to metadata. Independently
   verify macOS/Windows binary version output in native environments.
3. Run `npm ci && npm run typecheck && npm run build`, full Node CI, signed
   negative tests and native installer lifecycle tests on Linux, macOS and
   Windows. Require release verification workflow to succeed **without
   publishing**. Capture immutable run links and reviewed SHA. Resolve all
   actionable findings before any signature.
4. In the owner-only signing environment, obtain the private key securely
   **outside** the repository, verify permission `0600` or `0400`, and run
   `WORKER_RELEASE_EXPECTED_VERSION=X.Y.Z WORKER_RELEASE_EXPECTED_COMMIT=123456789abc ./scripts/sign-worker-manifest.sh /absolute/outside-source/private.pem`.
   The signer rejects stale signatures; sign only after a fresh unsigned build.
   This is an offline manual action, **never** an Actions job.
5. Independently derive and out-of-band compare the public-key fingerprint:
   `openssl pkey -pubin -in public.pem -outform DER -out public.der` followed
   by `sha256sum public.der`. Validate
   `openssl dgst -sha256 -verify public.pem -signature worker/bin/SHA256SUMS.sig worker/bin/SHA256SUMS`.
   Recheck all hashes after signing. Do not upload the signature, key or
   binaries while release approval is pending.
6. Present the owner a review packet: exact source SHA, release version,
   public-key SPKI SHA-256, nine artifact hashes, manifest signature digest,
   native tests/CI run URLs, supply-chain attestation, distribution HTTPS
   address, rotation record (if any), and maintenance/restore procedure.
   The owner explicitly approves the exact tuple and pinned installer code,
   then separately approves a narrowly scoped publication/deployment change.
   The existing unconditional Railway HTTP 503 must **not** be removed by
   this task or implicitly by a key update.

## Verification and separation of duties

The `worker-artifact-build.yml` manual build runs Go tests, creates all
platform binaries and checks hashes, but **does not upload** the outputs.
The PR job tests signed fixtures with disposable sandbox keys on Linux,
macOS and Windows; those keys/signatures are neither public trust roots nor
release artifacts. **Existing, separately owned `release-verify.yml` uploads
`reports/release/`, which includes unsigned Worker binaries.** Do not trigger
that GitHub workflow for this candidate without a separately authorized change
to remove binary collection/upload. Instead run the local disposable
`./scripts/release-verify.sh` in a controlled sandbox and keep evidence
private. This task has no ownership over that workflow. Review CI logs for
accidental `BEGIN PRIVATE KEY` or PEM paths; inspect `git ls-files`, Docker
build contexts and artifact inventories for private keys. Automated absence
checks cannot prove an uninspected external image or private signing host is
clean: retain an explicit manual evidence gate. Public repository Actions
artifacts are **not private storage**.

### Owner approval record (currently all pending)

| Gate | Required evidence | Status |
| --- | --- | --- |
| Immutable source & complete provenance | Reviewed 40-char SHA, unambiguous prefix, native version output | PENDING |
| Key custody | Owner-held external RSA key, SPKI fingerprint independently verified | PENDING |
| Root policy | Old/new fingerprint and separate rotation approval if applicable | PENDING |
| Signed package | Nine hashes, detached signature, independent verification | PENDING |
| Security | Full Node CI, three-OS offline negative/lifecycle tests, failure recovery | PENDING |
| Distribution & ops | HTTPS origin, isolation, owner recovery runbook and explicit release decision | PENDING |
| Publish authorization | Separate explicit owner approval; no automatic release or deployment | PENDING |

**Current decision: NO-GO** — no key, public binary, tag, Release or production
installer can be published based on this document alone.
