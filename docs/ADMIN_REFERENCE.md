# Administration and development reference

This document describes the **SQLite-only development branch** and its baseline Admin/OAuth/Worker behavior.

## Storage

The application uses a local **better-sqlite3** database at `DATABASE_PATH` (Docker default `/app/data/mcp_worker.sqlite`), with WAL, foreign keys, `busy_timeout=5000`, schema validation and `integrity_check`. Docker uses **one app container and one persistent app-data volume**. Do not run writable replicas against the same SQLite file and do not host the database on a shared network filesystem.

`./setup.sh --init` is for an entirely new installation. It initializes 13 SQLite application tables and an initial admin identity; `./setup.sh` subsequently starts/restarts without reset. Admin → Settings → Database is **read-only status**; there is no database-connection form or server-side setup action.

Storage state:
- `UNCONFIGURED`: no SQLite database exists yet; Admin login from environment can display setup guidance, but MCP data endpoints are not ready.
- `READY`: SQLite schema and integrity validated; OAuth, Users, Workers and settings may operate.
- `DEGRADED`: startup validation failed; do not erase or recreate the database as a workaround.

An obsolete bootstrap file causes a **fail-closed startup refusal**. This development release supports fresh SQLite setup only; use a clean project and empty volume.

## Identity and security

The infrastructure Admin authenticates with `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD`. Application Users have independent database-backed identities, sessions, OAuth clients and Worker ownership constraints. Encrypted settings and credentials rely on the stable `APP_ENCRYPTION_KEY`. Keep `ADMIN_PASSWORD`, `SESSION_SECRET`, and `APP_ENCRYPTION_KEY` private and persistent, and restore the matching set with a recovery snapshot. Do not create new secrets atop an existing volume.

The installer creates `.env.setup` with the project/port and **three generated secrets** (mode `0600`). It refuses obsolete installer credentials or a conflicting project volume so a fresh setup cannot silently replace an existing installation. There is no MySQL client or importer in the source build.

## Admin application

Use `/admin` for the overall runtime status, `/admin/onboarding` for Getting Started, `/admin/settings/database` for SQLite state, and `/admin/settings/mcp`, `/admin/settings/telegram`, `/admin/settings/runtime` for configuration. OAuth clients, Workers, terminal profiles and request audit are protected by the existing Admin and user-scoped authorization checks.

OAuth uses authorization code with PKCE and exact redirect URIs; access/refresh tokens have expiry and revocation. Worker enrollment is short-lived, single-use and ownership-aware. The Go Worker uses outbound WSS signed challenge authentication.

**Signed Go Worker distribution remains blocked:** `/worker/install*` and `/worker/dist/*` return **HTTP 503** until separately approved release-signing material exists. Do not bypass signature gates.

## Development

For an isolated developer checkout:

```sh
npm ci
npm run typecheck
npm run lint:typed
npm run format:check
npm run build
npm test
```

Tests use disposable SQLite databases; any skipped Docker/native Worker/remote integration checks must be reported explicitly. Never run database tests against a real installer volume. A disposable Docker integration test should validate fresh install, restart and core HTTP/OAuth/Worker contracts. No database-import step is required.

## Health and recovery

`/healthz` reports process liveness and storage state. `/readyz` returns HTTP 200 only when SQLite is operational; it may return 503 while explicit initialization is pending or database validation has failed. A healthy process does not imply that an OAuth client or Worker has authenticated.

For consistent WAL snapshots and independent restore drills see [Backup and restore](BACKUP_RESTORE.md). For local installation see [Quickstart](QUICKSTART.md), and for remote HTTPS endpoints see [Remote MCP](REMOTE_MCP.md). A new Docker image, deployment, migration of real data or modification to existing Worker trust roots requires separate owner approval.
