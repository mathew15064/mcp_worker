# Worker-only migration (TS6.3, 2026-11-12)

## Objective

Use authenticated outbound Go Worker WSS as the exclusive execution transport.
Retire user/admin SSH Profiles, browser shell WebSocket routes, SSH credential
storage and xterm/ssh2 dependencies. Keep OAuth, User ownership, Worker
identities, Worker Profiles (now **Execution Targets** in UI), audit and MySQL.

## Wire compatibility

- 15-tool catalog: runtime_info, terminal_list, workspace_exec, artifact_collect,
  file_read, file_write, file_patch, process_start, process_status, process_stop,
  process_logs, repo_snapshot, git_diff, code_search, check_run.
- terminal_list lists Worker aliases only; the four interactive terminal tools
  are retired. MCP clients must refresh their tool catalogs.
- OAuth scopes bot_report.read, bot_report.terminal, offline_access unchanged.
  bot_report.terminal authorizes Worker execution, not raw SSH.
- Ed25519 Worker identity, authenticated WSS, systemtd CLI, existing Worker
  state, and database migration history unchanged.
- HTTP legacy account/admin SSH profile routes return 404 for logged-in users.
  Browser WebSocket /terminal/ws upgrades return 404.
  Unauthenticated Worker WSS /worker/v1/connect returns 401.

## Admin Users management retired

- The Users link and create/list/enable/disable/reset-password Admin UI are removed.
- Authenticated requests to /admin/users and its historical subroutes return 404.
- Principal, session and ownership models remain intact so existing OAuth
  clients, Worker identities and account logins do not lose data or access.
- No SQL DROP, user deletion, forced logout, or password rotation is performed.
- New user provisioning is no longer offered by the Admin web UI.
- This is UI/API feature retirement, **not** deletion of existing identities.

## Data preservation

- Never drop terminal_profiles, terminal_connection_audit, old SQLite tables,
  Worker identity/profiles or migrated records. Old SSH data is retained for
  rollback and historical audit, but the current runtime cannot use it.
- Keep an immutable pre-cutover app image, private env/config and MySQL backup.
- Do not reinitialize DB, execute setup.sh --init, down -v, or rotate secrets.

## Acceptance

- Build, typecheck, unit/integration, Web UI and quality gate pass.
- Worker enrollment, outbound WSS/reconnect and 15-tool OAuth/PKCE MCP tests
  pass from a distinct network where safe credentials are available.
- TLS, cookie flags, /readyz, protected MCP, legacy route rejection, V3 health,
  private database data and rollback verification all pass.

## Deployment boundary

Canonical origin https://alive.locallhost.shop uses port 443. The historical
:18443 staging listener is off. Change only the isolated TS6.3 application
image in compose project ts63-alive-20261111, preserve volumes/database and
production V3, and do not merge PR #2 or publish a public release without
separate approval.
