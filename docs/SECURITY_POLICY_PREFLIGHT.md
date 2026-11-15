# Security Policy Preflight & Source Freeze Checklist — V2.0.0

**Decision:** **NO_GO** until owner decisions and mandatory release QA are complete.
**Scope:** Local PC test-only integration, branch `work/full5-integration-test-20261114`. All changes are **uncommitted**; `HEAD=48473a309b6f832a44265249ab7227c0d45c62c3` is the **baseline**, not an integrated release SHA. This checklist is not approval to commit, deploy, sign, or publish.

## Owner security policy matrix — Worker OS access approved; remaining decisions pending

| Policy | Verified current behavior | Approved or proposed policy | What remains |
| --- | --- | --- | --- |
| Admin / super-admin | `/admin` requires a role `admin` session; unowned OAuth clients are Admin-controlled. There is no separately approved audited super-admin escalation in this run. | Global Admin only until a separately audited super-admin design is approved. | Define cross-user operations and immutable audit evidence. |
| OAuth read / terminal / offline | New personal clients include **read only** by default; terminal/offline require unchecked opt-in. Registration and authorization with missing scopes also default to **read only**. Explicit elevated scopes remain subject to the client allowlist and consent. Existing grants are unchanged. | Read-only first-time setup; elevated terminal/offline grants only with informed approval. | Independently review historical grants and any authorized token revocation; **do not silently alter existing rights**. |
| Worker capability authority | Enrollment stores capabilities in the Worker repository. Heartbeat advertisements cannot increase persisted capabilities; operations check persisted grants. A later persisted grant **removal** now disconnects established WSS sessions and stops Worker-managed workloads after periodic detection. New grants do not become available on an old session. | Owner-granted allowlist; never trust heartbeat to authorize new capabilities. | Define who may approve/revoke grants and audit provenance. |
| `AllowShell` / OS authority | The Go and legacy Node Workers execute shell commands with the **OS account running their process**; the installer and service account may differ. | **Owner-approved:** new enrollments default to `allowed_roots: []` (any OS-accessible path) and `allow_shell: true` (shell enabled). An explicitly provided nonempty roots list or `BOT_REPORT_WORKER_ALLOW_SHELL=false` still restricts access. No mandatory OS sandbox or low-privilege service account is imposed. | Existing saved Worker config must be updated deliberately to `allowed_roots: []` and `allow_shell: true`, followed by restart, to opt into this policy. OS-level permissions still apply, and owner auth, OAuth/client scopes, persisted Worker capabilities, key verification and revocation stay enforced. |
| Worker identity / owner revocation | Disable via this server disconnects current sockets after persisted state update. Cross-instance owner/Worker identity/capability revocation is observed on the existing ~20-second monitor. Auth/status lookup failures close sockets (fail closed), and server-authoritative close stops managed processes, jobs and PTYs. | Fail closed; explicitly document time-to-revoke and operator restart procedure. | Owner must approve maximum distributed revocation lag and handling of processes outside Worker supervision. |
| Historical OAuth grants | Earlier migration may have widened grants in already-migrated databases. Read-only sanitized JSON audit and disposable SQLite/MySQL transaction fixtures exist; no real client is automatically downgraded. | Review original approved grants client by client; revoke associated access and refresh tokens in the same authorized transaction after backup. | Approve grant evidence, clone, notifications, rollback window and production data authorization **separately**. |
| Signed Worker / public release | Installer/distribution/enrollment remains HTTP **503/no-store** without independently approved signed release. | Keep fail-closed until immutable artifact hashes, signing root, key custody and owner release decision. | Independently approve trust root, native OS tests, version/commit tuple and release signing. |

**Verified unrestricted-Worker evidence:** The disposable Go Worker now enrolls without `--roots` or `--allow-shell` in the real localhost WSS/TLS + OAuth PKCE end-to-end test. It executes in a separate OS-permitted directory, writes and reads a file there, rejects an invalid OAuth token and retains capability-denial checks. This is Linux-local QA only; native Windows/macOS runtime acceptance remains pending.

**Preflight code paths:** `src/routes/adminRoutes.ts`, `src/routes/accountRoutes.ts`, `src/routes/mcpOAuthRoutes.ts`, `src/services/mcpOAuthService.ts`, `src/services/workerAuthService.ts`, `src/services/workerConnectionBroker.ts`, `src/services/workerReleaseGate.ts`, `worker-go/main.go`, `docs/HISTORICAL_OAUTH_SCOPES_REMEDIATION.md`. Statements above describe *current source*, not an owner-approved policy.

## Completed fail-closed technical preflight

- On each periodic Worker identity revalidation, a persisted capability **removal** disconnects the prior WSS socket with `4003 worker-capability-revoked`; the Go Worker recognizes this as an authoritative revocation and terminates its managed workloads without automatic reconnect.
- Capabilities **added** to the repository do not silently elevate an already connected Worker session.
- A session is bound to its authenticated **owner + public key + initial capability grants**. Key rotation, owner reassignment or grant removal closes the old socket on the periodic check and is also rejected **before any new job or stream** can be sent. Reconnect is required after an authorized key change.
- Existing socket-replacement checks prevent stale asynchronous owner/identity lookups from closing a new session.
- An offline Worker cannot receive a revocation close frame. A refused signed handshake (HTTP 401/403) or a verified `WORKER_OWNER_UNAVAILABLE` HTTP 503 now stops managed workloads and auto-reconnect; transient upstream errors remain retryable. Local TLS broker tests verify the actual JSON rejection codes.
- Before a new job or stream, a missing, disabled or unverified Worker database record now closes its existing WSS session immediately, without waiting for the next periodic check. Late database failures never close a replacement socket. Dispatch and stream also recheck the exact socket after the asynchronous owner-status check, so a replacement between authorization and transmission cannot receive stale commands.
- Focused Node and Go negative tests exercise revocation and normal reconnect; these tests do not set or approve any new grants.

## Source Freeze preparation — separate owner approval required

1. Confirm the clean baseline `BASE_SHA=48473a309b6f832a44265249ab7227c0d45c62c3` and `BASE_TREE=522e12c5347b4d8d6880e20d421b98127e855fbb`, with the five original T1–T5 worktrees unchanged.
2. Audit the *current* `git status --porcelain=v1 --untracked-files=all`, `git diff --check`, cumulative tracked binary patch SHA-256 and SHA-256 of **each untracked file**. The previous verified preflight counted 54 tracked and 10 untracked paths. Counts and file hashes must be **recomputed** at the final source-freeze checkpoint.
3. Reconcile T4↔T2 token revocation, T3 Worker owner/identity/capability revocation, and T1↔T5 signed installer/onboarding on **one integrated source tree**. Confirm the source-level policy decisions above are approved or remain release blockers.
4. Run Node full suite, Go 1.24 unit/race/vet, Chromium, MySQL disposable Worker-live, recovery non-root and signed installer against the current source. Keep all `SKIP`/`NOT_TESTED` counts visible.
5. Independently verify native Windows atomic writes and NTFS/ACL/reparse-point cancellation behavior, native macOS/systemd and any other platform to be supported; cross-compilation is **not** native acceptance.
6. Get **separate explicit approval** to stage all reviewed paths and create **one local integrated commit**; record the resulting immutable full `HEAD` and `TREE` before any release QA or build. A commit alone does not authorize a push/PR/merge/deploy.
7. On that frozen source, complete the remaining mandatory OCI builds/provenance, current dependency audit, SBOM/Trivy, native OS, live Railway pilot and independent offsite restore with separate budget/environment/secret approvals. No missing gate may be reported PASS.
8. Prepare a Release Candidate only after owner signs off the final matrix, rollback plan and signed-Worker trust root.

**Until steps 5–8 are verified and approved: `SOURCE_COMPLETE=NO`, `WAVE3_FINAL=NOT_READY`, `RELEASE=NO_GO`.**

Never apply historical grant changes to real data without an explicit owner-approved restore and revocation plan. This preflight performs no real-user or production operations.
