# Quick Setup and Source Setup — local Docker

**Quick Setup (recommended for users):** download the standalone
[`quick-setup.sh`](../quick-setup.sh) script, run `sh quick-setup.sh --init`
and let the published Docker image generate `.env.setup` in the current directory.
No source checkout, build toolchain, or Docker Compose is needed. Only Docker
Engine and a network connection to pull the image are required. The script must
be reviewed before execution; see the [README](../README.md#quick-setup--image-first-no-source-checkout).

**Source Setup (developers):** clone the repository and run `./setup.sh --init`.
This reuses an exact matching local image, including a previously pulled Docker Hub image (Git commit **and** tree), and builds
only on cache miss or `MCP_WORKER_FORCE_BUILD=1`. Fresh source installs use
Docker Compose and a *separate* SQLite volume from Quick Setup.

## Requirements for Source Setup

A Linux machine with Docker Engine, Docker Compose v2, Git, OpenSSL and
`flock` (plus `curl` for the optional health checks); network access for
pinned base images and build dependencies; enough
disk space for images and persistent volumes. Source mode builds Node.js 22 and the Linux Go Worker inside Docker: **Node.js is not required on the
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

This reuses a matching local image or builds one from checked-out source, initializes
a new SQLite database on the persistent app-data volume, and publishes port 3333 on **all IPv4 interfaces (`0.0.0.0`)**.
There is no database server or exposed database port. A cold build needs network access and its duration
depends on the host/cache. This release expects a fresh SQLite volume. Older SQLite filenames require the explicit offline migration documented in BACKUP_RESTORE.md.

From another machine, open `http://YOUR_VPS_IP:3333/admin` (or use
`http://127.0.0.1:3333/admin` on the VPS itself), sign in as `admin`, and read the generated
`ADMIN_PASSWORD` privately from `.env.setup`. The installer creates this
file (mode 0600) with three generated secrets (ADMIN_PASSWORD, SESSION_SECRET, APP_ENCRYPTION_KEY); **do not
create `.env`, share the installer file, regenerate secrets over existing
volumes, or expose the HTTP port to the Internet**.

The initial **Public Base URL** is derived from the host's outbound IPv4
interface (`ip route get`), not the Docker bridge or `0.0.0.0`. For a VPS
behind NAT, set `MCP_WORKER_PUBLIC_IP=<public-ip>` before setup. For a
reverse proxy, set `MCP_WORKER_PUBLIC_URL=https://your-domain.example`.
The chosen URL is persisted in `.env.setup` and the SQLite settings.
`MCP_ENABLED=true` is the initial default, but an Admin setting turned off
later stays off. A Profile automatically selects the only online Worker;
multiple online Workers require an explicit selection. Without an enrolled
online Worker, execution-target creation is unavailable.

**Security warning:** The published port is reachable from every network interface
unless restricted by the host/cloud firewall. Plain HTTP exposes Admin login
credentials to network observers; allow only trusted IPs or add an HTTPS reverse
proxy before Internet access. A bind address is not an OAuth issuer: configure
the public HTTPS base URL separately for remote MCP clients.

Existing Quick Setup installations that were bound to `127.0.0.1` can safely
switch to the new host binding with `sh quick-setup.sh --rebind`; this recreates
only the managed container and keeps the original image, SQLite volume and
`.env.setup` secrets.

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
`mcp_worker.read`, and save the one-time secret privately.

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
