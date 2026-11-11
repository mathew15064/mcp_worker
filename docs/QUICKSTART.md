# Local quickstart

mcp_worker V2 is a self-hosted MCP execution gateway, not an autonomous
coding model. Start with the local-only configuration. No domain, public
port, SSH server or ChatGPT subscription is required for the local smoke call.

## Requirements

Linux Docker host, Docker Engine and Compose v2, Git, OpenSSL, flock, an
Internet connection to fetch the pinned bases and build dependencies, and
enough disk space for images and persistent data. Use a clean checkout of
the approved V2 release candidate: https://github.com/mathew15064/mcp_worker. Node 26.13.0
is required on the local client machine for the optional first-call script,
not to run the Docker server or the Go Worker.

## Start and sign in

From a fresh checkout:

    git clone https://github.com/mathew15064/mcp_worker.git
    cd mcp_worker

    ./setup.sh --init

Open http://127.0.0.1:3333/admin. Sign in as admin using the generated
ADMIN_PASSWORD in .env.setup; view it privately on the host. This file is
mode 0600 and contains the database and encryption secrets. Never publish
it or regenerate it over existing volumes. The installer builds both app
and bundled database images and initializes only an empty dedicated source.
It binds the app to loopback; MySQL is not published. A measured local
build is not a guaranteed cold-install time.

Open Getting Started. MySQL should show READY; the endpoint should be
http://127.0.0.1:3333/mcp. Check:

    curl -fsS http://127.0.0.1:3333/healthz
    curl -fsS http://127.0.0.1:3333/readyz

Health means the web process is alive; readiness means the application
database is operational. Do not initialize/reset a nonempty database.

## Enroll a local Worker

Use a dedicated unprivileged OS account on the same host, with a dedicated
workspace directory. In Admin Workers create a short-lived enrollment
token. Download and inspect the Linux installer, then run it as that user:

    installer=$(mktemp)
    curl -fsS http://127.0.0.1:3333/worker/install-linux.sh -o "$installer"
    # Review the downloaded script before executing it.
    sh "$installer"
    rm -f "$installer"
    "$HOME/.local/bin/systemtd" login --server http://127.0.0.1:3333 --insecure-http

Enter the token at the hidden prompt and choose only the intended workspace
roots. Keep shell permission disabled for the first read-only call. If shell
execution is needed later, understand that it grants the OS user's command
authority; roots are not a shell sandbox. Use HTTPS for a remote Worker.
Do not overwrite an existing enrolled Worker or install as root. Check
systemtd status and actual online status in Admin. See [Worker lifecycle](../worker/README.md).

## First authenticated MCP call

Create an Admin OAuth client with exact redirect URI
http://127.0.0.1:43871/callback. Select bot_report.read only; uncheck Terminal
and Offline access. Save the one-time secret privately. On the same machine
as the browser and server, run:

    node scripts/first-mcp-call.js http://127.0.0.1:3333

Enter the ID and secret, open the printed URL in the browser and approve.
The helper validates OAuth state, uses PKCE, invokes runtime_info and attempts
to revoke the access token. It does not save credentials to disk. Audit Log
should show a successful runtime_info call; refresh Getting Started.

## Stop and resume

    ./setup.sh --down
    ./setup.sh --init

The same installer env and volumes are retained. Do not use down -v or
delete volumes to troubleshoot. See [backup and recovery](BACKUP_RESTORE.md)
before any maintenance, and [troubleshooting](TROUBLESHOOTING.md) if a step fails.
For remote connectors, read [remote MCP](REMOTE_MCP.md).
