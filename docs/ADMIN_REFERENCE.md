# Administration and development reference

For a new installation, start with the [local quickstart](QUICKSTART.md). This reference describes the advanced V2 configuration, storage, ownership, and development interfaces.

## Outbound Worker

1. In Admin, open **Workers** and generate a short-lived one-time enrollment token.
2. On the target machine install the Worker CLI directly from that mcp_worker deployment:

Linux:

```bash
installer=$(mktemp)
curl -fsSL https://bot-report.example.com/worker/install-linux.sh -o "$installer"
# Inspect the downloaded installer first.
sh "$installer"
rm -f "$installer"
```

macOS:

```bash
installer=$(mktemp)
curl -fsSL https://bot-report.example.com/worker/install-macos.sh -o "$installer"
# Inspect the downloaded installer first.
sh "$installer"
rm -f "$installer"
```

Windows PowerShell:

```powershell
Invoke-WebRequest https://bot-report.example.com/worker/install-windows.ps1 -OutFile .\install-windows.ps1
# Inspect the downloaded installer first.
& .\install-windows.ps1
```

3. Run the interactive enrollment flow:

```bash
bot-report-worker login
```

**Linux service safety:** The default installer is user-mode and does not install systemd or require sudo. Run as a dedicated low-privilege user. Systemd is an explicit advanced opt-in (`BOT_REPORT_WORKER_SYSTEMD=1`); existing systemd identities cannot be changed by the manual installer. For tests, use a disposable Docker container and separate HOME, Worker home, install root and bin directory. See [Worker lifecycle](../worker/README.md) for upgrade, rollback and signing.

Each installer downloads the matching standalone Go Worker from the same server and verifies it with SHA-256. `login` prompts for the one-time token and allowed roots, generates the Ed25519 private key locally, auto-creates a Worker Profile, starts the outbound worker in the background, and waits for authenticated WSS connectivity. Interactive terminal access uses a persistent PTY shell created on demand for that profile; no tmux session or inbound SSH connection is required. Once login prints `connected`, the returned profile alias is immediately usable by the existing MCP execution tools.

For automation, `bot-report-worker login` also accepts `--token`, `--roots`, `--name`, `--profile`, and the explicit `--allow-shell` switch. The one-time token is never stored after enrollment.

The private key stays in `~/.bot-report-worker/state.json` with restrictive permissions. Subsequent outbound WSS connections use signed timestamp + nonce authentication and replay protection. Administrators can disable an enrolled worker, which rejects future handshakes and terminates its active connection.

Enabling shell execution grants the mcp_worker execution surface the same command authority as the OS user running the worker. Allowed roots protect path-bearing APIs and select the execution working tree; they are **not a shell sandbox**. For strong isolation, run the worker as a dedicated low-privilege OS account or inside an OS/container sandbox you control.

See [Worker lifecycle](../worker/README.md) and [Worker architecture](V2_WORKER_ARCHITECTURE.md) for CLI, protocol and trust boundaries.

## Storage architecture

MySQL is the primary application database. The MySQL connection is configured from **Admin -> Settings -> Database**, not from normal DB environment variables.

The production runtime has five storage states:

```text
UNCONFIGURED        no MySQL configuration and no legacy database
MIGRATION_REQUIRED  legacy SQLite exists only as a read-only import source
CONFIGURED          MySQL connection is saved but mcp_worker source is not initialized
READY               MySQL is connected and the mcp_worker source is active
DEGRADED            MySQL configuration is saved but currently unavailable
```

An app started without explicit bundled initialization or saved database configuration starts in `UNCONFIGURED`. Administrator login and Settings remain available so MySQL can be configured entirely from the UI. Data-dependent pages and MCP/OAuth endpoints return `503` until MySQL is `READY`.

Database actions are intentionally separated. **Test Connection** is read-only. **Save Connection** only encrypts/stores the MySQL connection and inspects existing source state; it never creates or upgrades tables, and restart does not auto-initialize the source. If the saved database does not contain the current mcp_worker source, the UI exposes **Initialize Source** as the explicit schema-changing action.

Existing SQLite installations enter `MIGRATION_REQUIRED`. SQLite application data is not served in this state; it is preserved only for the one-time import. On the first **Initialize Source**, mcp_worker:

1. connects using the already-saved MySQL configuration,
2. creates or upgrades the mcp_worker MySQL schema,
3. imports legacy application data transactionally into an empty first-time source when applicable,
4. verifies imported row counts before commit,
5. switches the running application to MySQL only after initialization succeeds.

Legacy SQLite `users` and `sessions` are intentionally not imported. The administrator identity remains ENV-backed and browser sessions remain bounded in-memory state. Version 2 can create new database-backed users after the MySQL source is initialized.

## v2 users and client ownership

The ENV administrator is the infrastructure super-admin and remains usable even when MySQL is unavailable. Normal users are stored only in the initialized MySQL source and sign in through the same `/login` endpoint.

Each user receives stable isolated client identity fields:

```text
principal_id = principal:user:<user_id>
profile_id   = profile:user:<user_id>
```

OAuth clients created from the user workspace carry `owner_user_id` and inherit that principal/profile automatically. Users can list, create, rotate, enable/disable, revoke, and delete only their own clients. OAuth authorization also enforces ownership: a user-owned client can only be consented by its owning user, while unowned/global clients remain administrator-consented.

User-owned clients receive `bot_report.read`, `bot_report.terminal`, and optional refresh-token capability (`offline_access`). Worker enrollment tokens created from the user workspace carry `owner_user_id`; the enrolled Worker inherits that owner and every Worker Profile resolves ownership through its Worker. MCP execution is tenant-filtered: a user principal can list and execute only Worker Profiles owned by that user, and never receives Admin SSH profiles or global/unowned Workers. Existing global Workers remain `owner_user_id = NULL` and stay administrator-managed. Disabling a user invalidates web sessions through `session_version` and also blocks OAuth client authentication, authorization, refresh, and access-token use while the user remains disabled.

Admin **Users** provides create, enable/disable, password reset, client counts, and the generated client identity. A normal user's UI exposes **My Clients**, **Workers**, and **Profile**. Users can generate one-time Worker enrollment tokens, enroll machines, create additional Worker Profiles, and enable/disable only their own Workers.

## Bootstrap security configuration

These values remain outside the application database because the application must be able to authenticate an administrator and decrypt the MySQL connection even when MySQL is unavailable:

```text
ADMIN_USERNAME
ADMIN_PASSWORD
SESSION_SECRET
APP_ENCRYPTION_KEY
HOST
PORT
TRUST_PROXY
COOKIE_SECURE
NODE_ENV
```

Generate the application encryption key with:

```bash
openssl rand -base64 32
```

Existing installations may temporarily keep `TERMINAL_CREDENTIAL_KEY`; it is used as a compatibility fallback when `APP_ENCRYPTION_KEY` is absent so existing Terminal and Telegram envelopes remain decryptable. `TELEGRAM_CREDENTIAL_KEY` is only needed to migrate older Telegram `enc:v2` tokens.

The encrypted MySQL bootstrap file defaults to:

```text
data/bootstrap-config.json
```

The file contains host/port/database/username/TLS plus an AES-256-GCM password envelope and is written with mode `0600`. Plaintext MySQL passwords are never rendered back to the browser.

## Laravel-style migrations

MySQL schema evolution follows Laravel migration conventions while remaining a small Node.js implementation:

```text
src/db/migrations/
  2026_11_01_000001_create_system_settings_table.js
  2026_11_01_000002_create_terminal_profiles_table.js
  ...
  2026_11_01_000010_create_users_table.js
  2026_11_01_000011_add_user_ownership_to_oauth_clients.js
```

Each migration exports:

```js
module.exports = {
  async up(schema) {
    // apply schema change
  },
  async down(schema) {
    // reverse schema change
  }
};
```

MySQL tracks migrations in:

```text
migrations
  id
  migration
  batch
  executed_at
```

Commands:

```bash
npm run migrate
npm run migrate:status
npm run migrate:rollback
npm run migrate:rollback -- --step=2
npm run migrate:reset -- --force
npm run migrate:fresh -- --force
```

`rollback` without `--step` reverses the latest Laravel-style batch. `rollback -- --step=N` reverses the latest N migrations. `reset`/`fresh` are intentionally CLI-only and require explicit destructive flags; they are not exposed in the production Admin UI.

## Admin UI

After ENV-backed administrator login, `/admin` provides:

- **Overview** — runtime and storage readiness.
- **Audit Log** — MCP request history with client/tool/result filtering, compact pagination, and a viewport-bounded table with a sticky header.
- **Users** — create/disable users, reset passwords, inspect per-user client counts, and view generated client identities.
- **OAuth Clients** — create, rotate secret, enable/disable, revoke, delete, and jump to client activity across the installation.
- **SSH Profiles** — Worker-backed direct shell aliases with Test Shell, Attach Shell, enable/disable, and no stored SSH credential or tmux dependency.
- **Settings** — dedicated Database, MCP, Telegram, and Runtime pages.

If MySQL is `UNCONFIGURED` or `DEGRADED`, Settings stays available but data pages are blocked server-side. This is not only a UI disable state.

The browser shell uses short-lived one-time WebSocket tickets bound to the authenticated Admin/User session, SSH Profile ownership, and same browser origin. Browser input/output is relayed over the authenticated outbound Worker channel to a local PTY running as the Worker OS account; no SSH credential or tmux session is required.

## MCP and Telegram settings

Once an application database is operational, these are stored in `system_settings` rather than normal runtime ENV:

```text
mcp.enabled
mcp.public_base_url
mcp.access_token_ttl_seconds
mcp.refresh_token_ttl_seconds
mcp.auth_code_ttl_seconds
mcp.rate_limit_per_minute
telegram.enabled
telegram.chat_id
telegram.bot_token
```

Telegram Bot Token stays AES-256-GCM encrypted at rest.

## Developer setup

```bash
cp .env.example .env
npm ci
npm start
```

Open `/admin`, sign in using `ADMIN_USERNAME` / `ADMIN_PASSWORD`, then configure MySQL from Settings.

Playwright UI checks:

```bash
npx playwright install chromium
npm run test:e2e
```

Core tests:

```bash
npm test
```

The optional MySQL integration test is activated by `MYSQL_TEST_HOST` and related `MYSQL_TEST_*` variables. The project test workflow can run it against a disposable MySQL 8 container. The live Worker installer/MCP integration additionally requires `BOT_REPORT_ISOLATED_WORKER_TEST=1` and a disposable Docker container (with curl, git, bash, ripgrep and OpenSSL installed). It uses a separate MySQL test database, installs and uninstalls a temporary Worker, and calls all 19 MCP tools via authenticated HTTP. Set `BOT_REPORT_WORKER_UPGRADE_FIXTURE` to a distinct previously built Linux/amd64 Worker binary inside that disposable container to exercise checksum/signature rejection, upgrade, repeated install, failed-start restoration and rollback. Never point integration tests at a production database or mount the host Worker state into the container.

## SSH Profile management

SSH Profiles are Worker-backed aliases, not stored SSH connection credentials. Enroll a Worker first, then create an SSH Profile from the Admin or User workspace and select an online Worker. A profile can be tested with **Test Shell** or opened interactively with **Attach Shell**.

The attached terminal is a persistent PTY owned by that profile and runs as the local OS account that started mcp_worker Worker. No host, SSH port, SSH username, SSH password, or tmux session is configured in the profile. Admin profiles may bind only global/admin-owned Workers; User profiles may bind only Workers owned by that user.

## OAuth client management

```bash
npm run mcp-client -- list
npm run mcp-client -- add \
  --name ChatGPT \
  --principal principal:gpt_client \
  --redirect https://client.example.com/oauth/callback \
  --scopes "bot_report.read"
npm run mcp-client -- rotate <CLIENT_ID>
npm run mcp-client -- disable <CLIENT_ID>
npm run mcp-client -- enable <CLIENT_ID>
npm run mcp-client -- revoke <CLIENT_ID>
npm run mcp-client -- delete <CLIENT_ID>
```

Replace the example callback with the exact URI supplied by your MCP client. Client secrets are shown only at creation/rotation; only their SHA-256 hash is persisted.

## Administrator password

Administrator credentials are ENV-backed. Update `ADMIN_USERNAME` / `ADMIN_PASSWORD` in the runtime environment and restart mcp_worker. The old database password-rotation behavior has been removed.

A strong candidate can be generated with:

```bash
npm run rotate-admin-password -- --generate
```

The command only generates a value; it does not mutate a database or environment file.

## Health and readiness

```text
GET /healthz
```

always reports process health and the storage state. The process remains healthy in setup mode so the administrator can configure MySQL.

```text
GET /readyz
```

returns `200` only when production application storage is operational (`READY` MySQL), otherwise `503`. `MIGRATION_REQUIRED`, `UNCONFIGURED`, and `DEGRADED` remain recoverable through the Admin Settings UI but are not ready for MCP/data traffic.

## Docker deployment

Production keeps `/app/data` persistent for the encrypted bootstrap file and, during migration, the legacy SQLite source file.

```bash
cp .env.docker.example .env.docker
./deploy.sh --dry-run
./deploy.sh --apply
```

The reverse proxy must preserve WebSocket upgrade headers for both `/admin/terminal/ws` (SSH compatibility console) and `/worker/v1/connect` (v2 outbound workers).

See `DOCKER_DEPLOYMENT.md` for production details.
