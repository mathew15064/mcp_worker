# Install from source — local Docker

This is the recommended **local-only** setup of the mcp_worker server and
persistent SQLite. No public domain, inbound SSH port, Railway deployment or
ChatGPT subscription is needed. Worker installation is a separate gated
release step described below.

## Requirements

A Linux machine with Docker Engine, Docker Compose v2, Git, OpenSSL and
`flock` (plus `curl` for the optional health checks); network access for
pinned base images and build dependencies; enough
disk space for images and persistent volumes. The Docker image builds Node.js
22 and Go Worker binaries inside Docker: **Node.js is not required on the
host** for installation. Node.js **22.x** is required only if you choose the
optional OAuth helper or manual development setup.

## Install and check readiness

```sh
git clone https://github.com/mathew15064/mcp_worker.git
cd mcp_worker
./setup.sh --init
curl -fsS http://127.0.0.1:3333/healthz
curl -fsS http://127.0.0.1:3333/readyz
```

This builds one application image from the checked-out source, initializes
a new SQLite database on the persistent app-data volume, and binds the service to loopback.
There is no database server or exposed database port. A cold build needs network access and its duration
depends on the host/cache. This SQLite-only development release expects a fresh data volume; it does not import earlier database formats.

Open http://127.0.0.1:3333/admin, sign in as `admin`, and read the generated
`ADMIN_PASSWORD` privately from `.env.setup`. The installer creates this
file (mode 0600) with three generated secrets (ADMIN_PASSWORD, SESSION_SECRET, APP_ENCRYPTION_KEY); **do not
create `.env`, share the installer file, regenerate secrets over existing
volumes, or expose the HTTP port to the Internet**.

`/healthz` checks that the server is alive; `/readyz` checks that the
database is operational. In **Admin → Getting Started**, SQLite should be
`READY` and the local MCP endpoint is http://127.0.0.1:3333/mcp.

## Go Worker installation is not available in this release candidate

This development source/image does **not** include an approved
production-signed Worker installer. All `/worker/install*` and
`/worker/dist/*` endpoints return **HTTP 503**
(`WORKER_SIGNED_RELEASE_PENDING`), including local installations.

Do not download/execute example installer commands, bypass signature checks
or replace an enrolled Worker identity. Admin/SQLite and the read-only
`runtime_info` OAuth test below can be checked without a running Worker;
file, Git, process and shell execution requires an approved, enrolled Worker.
See [Worker lifecycle](../worker/README.md) for future signed-installation
requirements.

## Optional first authenticated MCP call (local host)

On the **same machine** as the server and browser, install Node.js **22.x**
only for this helper. In the same repository checkout, create an Admin OAuth
client with exact redirect URI `http://127.0.0.1:43871/callback`, select only
`bot_report.read`, and save the one-time secret privately.

```sh
npm ci
npm run build
node dist/scripts/first-mcp-call.js http://127.0.0.1:3333
```

The Docker server build does not populate host `dist/`: the local build
above is needed for this helper. Enter the ID/secret at the terminal prompts,
open the printed authorization URL and approve Read access. The helper
uses PKCE and OAuth state, calls `runtime_info` and attempts token revocation.
It does not save the credentials to disk. The local callback port must be free.
This check does **not** enroll a Worker or validate remote ChatGPT HTTPS.

## Stop, restart and recover

```sh
./setup.sh --down
./setup.sh
```

`--down` preserves `.env.setup` and the app-data named volume; `./setup.sh`
restarts without requesting database initialization. Use `./setup.sh --init`
only for explicit initialization of a **fresh** database. Do not use
`down -v` or delete volumes as a troubleshooting step. Read the
[backup and recovery guide](BACKUP_RESTORE.md) and
[troubleshooting guide](TROUBLESHOOTING.md) before maintenance.
For external clients, read [remote HTTPS MCP](REMOTE_MCP.md).
