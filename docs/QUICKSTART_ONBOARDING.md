# Railway first-run wizard (T5)

Scope: `/setup`, Admin **Getting Started**, OAuth Clients, Workers, and the read-only MCP verification step. This is a UI/local-test change; it does **not** approve a Worker release, deploy to Railway, authorize OAuth, or execute commands on someone's machine.

## Audit: current route to a verified MCP call

1. New Railway instance: `GET /setup` is available only with `MCP_PLATFORM=railway`, a working mounted SQLite volume, and no previously claimed Admin. The form requires the private setup key plus a new confirmed Admin password. The global CSRF middleware protects the POST; setup attempts are rate limited; owner claim is single-winner and stores a bcrypt hash, never the password.
2. After a successful claim the server redirects to `/login`. The existing session records `/admin/onboarding` as the next destination. Login still requires the Admin password and regenerates the session ID.
3. The signed-in Admin sees six evidence-based stages: Admin sign-in, persistent database, MCP endpoint/transport, Worker, OAuth client, authenticated `runtime_info` call. The page also has an explicit **Connect ChatGPT (manual)** section.
4. Server-side readiness data comes from the existing Admin onboarding route: database operational status, canonical MCP configuration, active client with Read scope, enabled online Admin Worker with enabled profile, and the recorded successful `tools/call`/`runtime_info` event for an active global OAuth client. `GET /readyz` is **not** proof of end-to-end readiness.
5. The browser reads same-origin OAuth discovery and compares `issuer` and `token_endpoint` to the configured endpoint. This is **not** an external reachability test. On Railway the browser uses only `HEAD /worker/install.sh`: HTTP 503 indicates the installer gate, with no script downloaded or executed.
6. **Pinned-base blocker:** the Railway Worker distribution endpoints intentionally respond with `WORKER_SIGNED_RELEASE_PENDING` (503). The T5 UI marks the Worker stage and overall onboarding **Blocked**, even if an unrelated Worker is already online or a read-only MCP call succeeded. The blocker must be resolved through a separately reviewed signed release; T5 cannot and does not bypass it.
7. A successful `runtime_info` audit record confirms an authenticated MCP call by a currently active Admin-owned OAuth client. It cannot independently establish that the originating UI was ChatGPT, that the browser can access the server from outside the deployment, or that arbitrary Worker shell operations are safe.

## What a new user does

1. In Railway choose the repo's Deploy flow, open the new service URL with **HTTPS**, and complete the one-time `/setup` form with the deployment's private setup key and a distinct strong Admin password. No Docker, SSH, database client or hand-written `.env` is needed for the web steps.
2. Sign in using **admin** (or the configured Admin username) and the password just created. The wizard opens under Getting Started.
3. Check the persistent SQLite and MCP configuration indicators. Use **Copy endpoint** to copy the canonical `https://<your-domain>/mcp` URL. A working internal metadata check does not replace confirming that the public certificate and URL are reachable from ChatGPT.
4. Open **OAuth clients** from the wizard. For the ChatGPT-first-run form the display name and a suggested ChatGPT callback URI are filled in; **replace the callback with the exact URI displayed in ChatGPT** if it differs. The default scope is only `bot_report.read`. Explicitly submit the create form and save the one-time Client ID and client secret **privately** (not into a ChatGPT prompt, support ticket or screenshot).
5. **Manual, presently blocked on Railway:** until the owner has approved a signed Worker release, stop before installing/enrolling a Worker. After approval, generate a short-lived enrollment token in Workers, install on a machine you control, explicitly log in with an allowed root, and check that an enabled profile and the Worker connection are online. The existing enrollment flow auto-creates a Worker profile; this wizard never creates a token or grants command execution itself. Shell permissions carry full OS-user authority.
6. In ChatGPT's MCP connector/app settings (UI wording may differ), provide the endpoint and credentials through its dedicated secure OAuth flow. Explicitly review and approve the presented scopes. Do not allow Worker execution or offline access unless specifically intended.
7. Run the read-only `runtime_info` tool with empty arguments from ChatGPT (or another trusted OAuth client) and refresh the wizard. Verify a successful `tools/call` record in **Audit Log** and separately confirm the connector status in ChatGPT. A missing or unsuccessful audit record remains Pending.

## Status definitions and fail-closed behavior

- **Done / Complete:** server-backed fact (Admin authenticated, persistent DB available, safe endpoint configured, active Read client, enabled online Worker profile, or successful authenticated audit event). These are independent; completion of one does not imply the others.
- **Pending / Next:** required fact absent, or cannot be safely inferred. The live browser probes never grant capabilities or mark the whole wizard Ready.
- **Blocked:** Railway signed Worker distribution returns HTTP 503, or the required storage/transport is unavailable. No unsigned installer fallback, shell access, OAuth consent, or background auto-install is offered.
- **All six steps complete:** existing non-Railway behavior requires each corresponding fact; Railway is intentionally prevented from declaring overall completion while signing is gated.
- **ChatGPT manual verification:** a successful audit call proves OAuth MCP activity, not which UI issued the call. The user must verify ChatGPT's actual connector status.

## Manual-work reduction (compared with the pinned-base UI)

| Interaction | Before T5 | T5 | Saved |
| --- | --- | --- | --- |
| Go to Getting Started immediately after creating Admin | Login then find the Getting Started link | Post-setup session navigates to onboarding after sign-in | 1 navigation |
| Find/copy MCP endpoint from Getting Started | Locate it on Overview / MCP Settings | Inline copy action in wizard | 1 navigation (copy still manual) |
| First-run OAuth display name | Manually type | Suggested `ChatGPT` value | 1 field |
| First-run OAuth callback | Manually type | Suggested URI, always confirm against ChatGPT | Up to 1 field when exact |
| First-run OAuth scopes | Read selected already; terminal/offline unchecked for `first_call` | Same secure default | 0 changes |
| Check signed installer HTTP status | No safe check shown in wizard | Automatic same-origin HEAD (no script execution) | Additional automated evidence, **not** an approved release |

**Quantified:** 2 navigation actions and up to 2 form fields eliminated in the common path, with no reduction in required explicit OAuth consent, Worker enrollment/installation, password handling, or ChatGPT verification. If ChatGPT provides a different callback, the user must still enter it.

## Local-only verification

From the isolated worktree on the PC:

```sh
npm run build
npm run typecheck
node --test --test-concurrency=1 dist/tests/railway-sqlite-quickstart.test.js
npm test
npx playwright test --config dist/playwright.config.js --project chromium --grep "Getting Started"
```

The Railway SQLite test uses a temporary local SQLite volume, an HTTP listener bound to `127.0.0.1` with simulated forwarded HTTPS, real CSRF/session/login/OAuth PKCE, the actual authenticated `runtime_info` tool, a 503 installer response, and restart persistence. All test resources are local and disposable. Do not substitute test fixtures or a successful `/readyz` for signing approval in production.

## Boundaries

Only T5-owned UI/setup routes, admin browser script, Railway quickstart test, and this document are changed. No OAuth service internals, Worker signing, Railway IaC, database schema, Dockerfiles, CI/CD, push, merge, or deployment. The wizard does not send secrets in links, logs, or status responses. There is no automatic OAuth grant or remote shell command.