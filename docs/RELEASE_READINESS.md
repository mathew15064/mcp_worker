# Railway one-click beta — owner GO / NO-GO checklist (T5)

**Current decision: NO-GO for public launch or a claim of full readiness.** The pinned local base for this checklist is `ae588a1a56f2561ca2323457463e5b9e203de509` (2026-11-13). This is an owner approval worksheet, **not** permission to push, sign, deploy, spend, publish or accept OAuth grants for anyone. Local sandbox tests are not live deployment evidence.

## GO gates — each requires explicit owner review

Record a reviewer, dated decision, immutable evidence link and **PASS / FAIL / NOT_TESTED** for every gate. Any FAIL, NOT_TESTED, absent reviewer or unapproved cost makes the decision **NO-GO**.

| Gate | Required independent owner evidence | Status at T5 handoff |
| --- | --- | --- |
| 1. Source freeze | Reviewed **complete 40-character immutable release SHA**, lockfile, IaC, signature pin, release notes and reproducible local build provenance. Never substitute the old draft PR or floating branch for a release-accepted commit. | NOT APPROVED |
| 2. Local quality | On PC: `npm ci`, typecheck, build, Node/OAuth/SQLite tests, all Playwright desktop/mobile/unsafe tests, typed lint/format review for owned files, required Go 1.24 unit/race/vet/build, signed-gate negatives, local Docker/volume and recovery checks. Keep separate logs, exits and hashes; do not use CI. | Reviewer must check combined branch |
| 3. Remote GitHub Actions off | Repository owner independently verifies **repository-level Actions disabled** *before* any push, PR update or tag; remote historical workflows may still be enabled despite their removal from local source. No automated build/test/release jobs may run. | NOT VERIFIED; push forbidden |
| 4. Worker trust root and release | Owner approves exact Worker version/commit, independently checked SPKI fingerprint/public-key pin, signed manifest and all platform artifact hashes. Verify installers reject tampering, rollback, key substitution and unknown native platforms. Private key stays off-repo/off-CI. Until approval, Railway installer must return HTTP 503 `WORKER_SIGNED_RELEASE_PENDING`; **no unsigned fallback**. | BLOCKED |
| 5. Native Worker acceptance | Real local Linux/macOS/Windows test results and owner-reviewed allowed-root/OS-user shell permission warnings; verify outbound WSS, lifecycle, enrollment and safe denial. Cross-compilation alone is not a native pass. | NOT VERIFIED |
| 6. Railway resources/billing | Owner approves provider/account, paid plan/volume limits, **one service, one persistent SQLite volume, one replica**, monthly budget/cap and alarm, a unique public domain and HTTPS/TLS, redirect origins and no shared production database or credentials. Review a real linked plan before any apply. | NOT APPROVED |
| 7. Secrets and access | Provision unique high-entropy setup key, Admin password and instance keys through approved protected surfaces; test CSRF, session rotation, secret rotation and one-time OAuth secret. Never put secrets in logs, URL/query strings, screenshots, ChatGPT prompts or Drive reports. | Live NOT_TESTED |
| 8. Disaster recovery | Test SQLite online backup sent to **encrypted, access-controlled, versioned off-platform storage**, verify restore to a distinct empty instance and secret escrow/recovery; specify RPO/RTO, retention, operator and off-platform credentials. Backing up only to the Railway volume is not recovery. | NOT APPROVED / live NOT_TESTED |
| 9. External first-user E2E | On an **owner-approved** paid test project and real public HTTPS domain: deploy, claim Admin, sign in, check persistence across restart, issue read-only OAuth client with ChatGPT's **actual** callback, approve only `bot_report.read`, connect real ChatGPT, prove an externally initiated `runtime_info` call and audit it, separately verify ChatGPT connection, then enroll a signed Worker only after its release approval. Test invalid URL, denied consent, CSRF, callback mismatch, token replay, offline/terminal scope rejection and installer 503. | NOT_TESTED: no accepted public Railway endpoint |
| 10. Public template publication | Only after all prior gates PASS and explicit **separate** owner release/publication approval: validate one-click repository source ref, billing disclosure, domain, persistent volume, rollback and support text. Never fabricate a template URL or Deploy badge. | PROHIBITED |

**Final GO rule:** all gates PASS with an owner-signed decision, real external first-time-user pilot, accepted budget and documented recovery. A private local smoke test, `/readyz` 200, a connected Worker, OAuth client registration, or even a successful MCP audit does **not** substitute for ChatGPT connection attestation or signing consent.

## First-time owner pilot (record actions, screenshots with secrets redacted)

1. **Deploy** — after owner approval only, select the approved immutable source in Railway; read plan/billing and confirm one attached persistent volume before deploying. There is currently **no public Deploy Template URL**.
2. **Admin** — open the approved HTTPS domain, enter setup key *in* `/setup`, choose a different strong Admin password, sign in. Confirm Getting Started opens without SQL, SSH, Docker or hand editing `.env`.
3. **Endpoint** — verify volume, canonical HTTPS issuer/discovery and certificate from an external network; copy `/mcp`. Browser same-origin discovery is *not* external connectivity evidence.
4. **OAuth** — in ChatGPT capture its callback URI, create a client with only `bot_report.read` enabled, securely store the one-time ID/secret in the connector form; record explicit consent, denial/callback/PKCE failure tests.
5. **Signed Worker** — while unsigned, expect 503 and STOP. Only with separately signed release approval, install on a personally controlled machine, generate a short-lived enrollment token, choose explicit allowed roots, connect outbound WSS and confirm an enabled online Worker profile. Do **not** grant terminal permissions for a read-only first call.
6. **ChatGPT** — connect using ChatGPT's own UI, explicitly approve the minimum scopes, invoke `runtime_info` with `{}`, match the authenticated Admin-owned audit event to the trial time/client, and check the actual ChatGPT connection status independently. Record success/failure and time spent by the pilot participant.

## Manual actions that cannot be removed safely

Railway plan/billing/domain confirmation; protected setup-key handling and Admin password creation; ChatGPT callback validation and OAuth explicit consent; storing the one-time client secret; release-owner signed Worker approval; initiating local Worker installation/enrollment with explicit OS allowed-root permissions; actual ChatGPT connection and read-only call; independent remote backup and restore. No automatic shell execution, remote OAuth approval or background installation.

## Rollback / abort

**Before publish:** leave signing gate on HTTP 503; do not expose a Deploy badge or template; leave unapproved source local. Stop if source, billing, permissions, signing provenance or external E2E do not match approved records.

**If a test deployment fails:** block new OAuth clients/enrollments and revoke compromised tokens through approved Admin controls; restrict public access at the approved Railway project without destroying the persistent volume. Preserve logs with credentials redacted, immutable source/version info, and an online SQLite snapshot exported off-platform using approved procedures. Do not downgrade a Worker binary across signed anti-rollback policy or silently rotate a trust root.

**If the database or volume is lost:** restore only after preflight validation to a **new empty, isolated** volume using the encrypted off-platform backup and the matching approved secrets; verify SQLite integrity, sessions, OAuth client/revocation state, Worker isolation and an authenticated read-only MCP probe before reopening external access. An on-volume snapshot is not sufficient. Reversion of a Railway service must use an owner-approved immutable known-good image/source and compatible database schema; do not reset or overwrite the volume as a rollback shortcut.

**If Worker trust is in doubt:** keep distribution gated, revoke affected enrollment tokens and credentials, isolate the Worker, independently investigate signing material, and require a separate owner-approved key-rotation/recovery protocol. Never bypass the approved public-key pin.

Release operator records: approved SHA: ______; owner signature/date: ______; Railway project/domain/budget: ______; backup location/restore proof: ______; signed Worker version/key digest: ______; native OS pilot: ______; external ChatGPT E2E: ______; final GO/NO-GO: **NO-GO pending approval**.
