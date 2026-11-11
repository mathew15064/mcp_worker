# Advanced external-proxy deployment

For a new standalone installation use `./setup.sh --init`. The instructions below are for the existing external-proxy topology. Use `docker-compose.proxy.yml` (not the standalone default).

# mcp_worker — Docker Deployment

mcp_worker runs as one non-root Node.js container on an existing reverse-proxy Docker network. Source and production dependencies are baked into the image; `/app/data` is persistent bootstrap/migration state.

## Required host state

- Docker Engine + Compose v2
- `.env.docker` created from `.env.docker.example`

`deploy.sh --apply` now prepares the runtime prerequisites for a fresh VPS: it creates the configured external Docker network when missing and creates `./data` with runtime ownership when missing. Existing network/data contents are preserved and are never deleted by the deploy flow.

The application no longer requires a SQLite database in order to start. A fresh deployment can boot with no application DB, authenticate the administrator from ENV, and configure MySQL through `/admin/settings`.

Existing installations may keep `data/bot_report.sqlite` temporarily. mcp_worker detects it as `MIGRATION_REQUIRED`; SQLite is preserved only as a read-only import source and data/MCP surfaces stay disabled until MySQL activation succeeds.

## Bootstrap configuration

```bash
cp .env.docker.example .env.docker
chmod 600 .env.docker
```

Required bootstrap/security values include:

```text
BOT_REPORT_EXTERNAL_NETWORK
SESSION_SECRET
ADMIN_USERNAME
ADMIN_PASSWORD
APP_ENCRYPTION_KEY
```

For an existing installation, `TERMINAL_CREDENTIAL_KEY` can remain instead of `APP_ENCRYPTION_KEY` during transition so existing encrypted Terminal/Telegram credentials remain readable.

MySQL host/port/database/username/password, MCP operational settings, and Telegram operational settings are configured from the Admin UI rather than normal runtime ENV.

## Validate and deploy

```bash
./deploy.sh --dry-run
./deploy.sh --apply
```

`deploy.sh` validates bootstrap secrets without printing them, validates Compose, prepares `./data` and the external network, requires a clean Git tree and configured upstream, performs `git pull --ff-only`, rebuilds the application image with Docker cache, force-recreates only `bot-report`, and waits for Docker process health. It never drops MySQL databases or removes legacy SQLite data.

## Health vs readiness

Process health:

```text
GET /healthz
```

returns HTTP 200 even when MySQL is not configured/unavailable so the Admin UI remains reachable for recovery. The payload includes the production database state (`UNCONFIGURED`, `MIGRATION_REQUIRED`, `READY`, or `DEGRADED`).

Application readiness:

```text
GET /readyz
```

returns HTTP 200 only when application storage is operational. It returns 503 in setup/degraded mode.

## Configure MySQL after deploy

1. Open `/admin` and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
2. Open **Settings -> Database**.
3. Enter MySQL connection fields.
4. Use **Test Connection**. This is read-only.
5. Use **Save Connection**. This only encrypts/stores the connection and inspects whether a mcp_worker source already exists; it does not create or upgrade schema objects.
6. If the UI reports that the source is not initialized, use **Initialize Source** explicitly.

`Save Connection` is intentionally non-destructive with respect to the MySQL schema, and restarting mcp_worker does not auto-initialize a saved source. `Initialize Source` is the only Admin UI action that creates/upgrades mcp_worker tables. On first initialization from `MIGRATION_REQUIRED`, legacy SQLite application data is imported transactionally into the newly initialized source and verified before MySQL becomes active.

MySQL password is AES-256-GCM encrypted in:

```text
/app/data/bootstrap-config.json
```

and is never rendered back to the browser.

## Migrations

Before any schema change, make a database-admin-approved backup and test recovery. Do not use reset/fresh as troubleshooting.

Schema migrations live under `src/db/migrations/` and use timestamp filenames plus `up/down` functions. MySQL records migration name, batch, and execution time in the `migrations` table.

```bash
npm run migrate
npm run migrate:status
npm run migrate:rollback
npm run migrate:rollback -- --step=2
npm run migrate:reset -- --force
npm run migrate:fresh -- --force
```

Rollback without `--step` reverses the latest Laravel-style batch. `--step=N` reverses the latest N migrations. Reset/fresh are destructive and intentionally remain CLI-only.

## Reverse proxy

See [remote MCP and ChatGPT](docs/REMOTE_MCP.md) for TLS, OAuth and external verification. This topology remains advanced and has not been externally release-certified.

Proxy the public MCP hostname to:

```text
http://bot-report:80
```

Preserve the public `Host`, forwarded protocol, and WebSocket upgrade headers. WebSocket upgrade support is required for both the browser SSH compatibility console at `/admin/terminal/ws` and the v2 outbound worker connection at `/worker/v1/connect`:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
```

## Persistent data

The bind mount remains:

```text
./data -> /app/data
```

After MySQL cutover it primarily contains the encrypted bootstrap configuration. The old SQLite file can be retained as a rollback/archive source until migration verification is complete, then archived or removed separately.

## Verification after deploy

1. `docker compose -f docker-compose.proxy.yml ps` reports `bot-report` healthy.
2. `GET /healthz` returns the expected storage state.
3. If MySQL is configured, `GET /readyz` returns 200 and Settings shows `READY`.
4. OAuth discovery endpoints expose the configured MCP public base URL when storage is operational.
5. Refresh the MCP connector/tool schema.
6. Call `runtime_info` and confirm Git SHA/build identity/tool count.
7. Confirm `tools/list` still exposes exactly 19 coding-harness primitives.
8. In SSH Profiles, Test Connection verifies SSH + the configured tmux session.
9. Browser SSH WebSocket reaches `/admin/terminal/ws` through the reverse proxy.
10. A v2 Worker can enroll and maintain outbound WSS connectivity through `/worker/v1/connect`.
