# mcp_worker

## Docker image (public release candidate)

The standalone Linux/amd64 image is available on
[Docker Hub](https://hub.docker.com/r/mathew15604/mcp-worker).
Latest candidate: [v2.0.0-rc.2 source](https://github.com/mathew15064/mcp_worker/tree/v2.0.0-rc.2) (Go Worker only). The previous `2.0.0-rc.1` remains available.

```sh
docker pull mathew15604/mcp-worker:2.0.0-rc.2
```

Immutable image: `docker.io/mathew15604/mcp-worker@sha256:001bb9642fd5b5098c29cecc15dc466f29c66e3a5d6d7725be84b9565134ca3b`.

**Digest erratum:** The existing annotated Git tag message for `v2.0.0-rc.2` accidentally truncates the digest; use the verified 64-character digest above.

**Release-candidate limitations:** The signed Worker installer distribution remains disabled
(`/worker/install*` and `/worker/dist/*` return HTTP 503); this is not a
production-signed Worker release. Configure secrets and persistent data/backup
storage before using the container with real data. No Railway service or CI/CD is required.

mcp_worker is a deterministic MCP coding execution harness. ChatGPT performs reasoning; mcp_worker exposes bounded MCP primitives and routes execution through an explicit execution profile.

Worker-only deployment: machines run standalone Go Workers that connect **outbound** over
authenticated WSS. The MCP server never opens inbound SSH connections or stores SSH
credentials. Browser SSH/terminal consoles and user/admin SSH Profiles are removed.

    ChatGPT / MCP Client -> OAuth/PKCE -> mcp_worker MCP Server
                                         |
                                  authenticated WSS
                                         |
                                  enrolled Go Worker -> local machine

The Admin UI focuses on OAuth Clients, Workers (including Execution Targets), Audit
and system settings. The terminal_list tool still lists Worker aliases for compatibility.

## Version and release policy

GitHub `main` is the active development baseline. The Worker-only service exposes MCP tools over outbound Go Worker transport. Docker release candidates use versioned Git tags; the signed Worker installer remains gated until separately approved. See [release checklist](docs/RELEASE_CHECKLIST.md).

## Compatibility identifiers

The product is mcp_worker. The V2 OAuth scopes (bot_report.read and bot_report.terminal), BOT_REPORT_* configuration variables, Worker binary filenames, systemtd CLI, existing Worker state directories and database schema retain their historical identifiers for compatibility. Existing installer env files keep their project name; fresh standalone installs default to mcp_worker. Do not rename or copy live Worker identities.

## License

The project source is licensed under [MIT](LICENSE). Third-party components retain their own licenses and notices; see [dependency review](docs/THIRD_PARTY_DEPENDENCIES.md).

## Documentation

- [Local quickstart](docs/QUICKSTART.md) and [remote MCP / ChatGPT](docs/REMOTE_MCP.md)
- [Worker installation and lifecycle](worker/README.md) and [security model](docs/SECURITY_MODEL.md)
- [Backup, restore and upgrade](docs/BACKUP_RESTORE.md) and [troubleshooting](docs/TROUBLESHOOTING.md)
- [Release engineering](docs/RELEASE_ENGINEERING.md), [release checklist](docs/RELEASE_CHECKLIST.md) and [changelog](CHANGELOG.md)
- [Administration and development reference](docs/ADMIN_REFERENCE.md), [contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md)

## Install from source with Docker (local only)

On a Linux host with Docker Engine, Compose v2, Git, OpenSSL and `flock`
(plus `curl` for the optional health checks), with network access to fetch
pinned base images and build dependencies:

```sh
git clone https://github.com/mathew15064/mcp_worker.git
cd mcp_worker
./setup.sh --init
curl -fsS http://127.0.0.1:3333/healthz
curl -fsS http://127.0.0.1:3333/readyz
```

`./setup.sh --init` builds the app and bundled MySQL image from this source
checkout, then explicitly initializes only an empty dedicated database.
Open http://127.0.0.1:3333/admin and sign in as `admin`. Read the generated
password privately from `.env.setup` (mode 0600). **Do not create a separate
`.env` for Docker**, publish secrets, or expose this local HTTP port remotely.
Back up `.env.setup` and both Docker data volumes together.

Use `./setup.sh` to start an existing installation without initializing a
database, and `./setup.sh --down` to stop without deleting secrets or volumes.
Never use `docker compose down -v` to troubleshoot. For a fresh, isolated
installation use separate `BOT_REPORT_SETUP_ENV`, `BOT_REPORT_SETUP_PROJECT`
and `BOT_REPORT_SETUP_PORT` values; keep them consistent on subsequent runs.

The Admin/MySQL setup works now, but **signed Go Worker downloads are not yet
approved**: `/worker/install*` and `/worker/dist/*` return HTTP 503.
Do not attempt a Worker installer or bypass the signing gate.
See [source installation steps](docs/QUICKSTART.md),
[manual Node development setup](docs/ADMIN_REFERENCE.md#developer-setup),
and [backup/restore](docs/BACKUP_RESTORE.md).

## Getting Started — first authenticated call

After signing in, open **Getting Started** in Admin (or
`/admin/onboarding`). The six-step checklist reads current MySQL readiness,
MCP configuration, live global Worker profiles, active OAuth clients and
successful runtime_info audit evidence. Refresh after each step. It does
not change database configuration or issue credentials automatically.

For a local-only first call, create an Admin OAuth client with the exact
redirect URI `http://127.0.0.1:43871/callback` and only the
`bot_report.read` scope. Save the one-time secret privately. On the same
machine as the browser and standalone service, with Node.js 22 installed,
install and build the optional local client helper (the Docker build does not
create `dist/` on the host):

```sh
npm ci
npm run build
node dist/scripts/first-mcp-call.js http://127.0.0.1:3333
```

Enter the client ID and secret at the prompts (secret is hidden), open
the printed authorization URL in your browser, sign in and approve Read
access. The helper listens only on loopback for the PKCE callback, calls
runtime_info and revokes its short-lived access token. It does not write
credentials to disk. Refresh Getting Started or Audit Log to see evidence.
If the callback port is in use, stop the conflicting local process or
use a separate OAuth-capable MCP client; do not expose the callback port.

A remote ChatGPT connector cannot reach your loopback URL. Configure HTTPS,
a trusted reverse proxy, secure cookies and the public MCP base URL before
using a remote connector. Register its exact callback URI (not the local
helper URI). Add terminal scope only after reviewing Worker permissions.

## Core MCP tools

The Worker-only MCP registry exposes exactly **15 tools**:

- Runtime: runtime_info
- Worker alias discovery: terminal_list
- Execution and evidence: workspace_exec, artifact_collect
- Files: file_read, file_write, file_patch
- Git/review: repo_snapshot, git_diff, code_search
- Checks: check_run
- Managed processes: process_start, process_status, process_logs, process_stop

All execution travels through the selected Worker over authenticated outbound
WSS. The retired interactive terminal_status, terminal_read, terminal_send
and terminal_interrupt tools are no longer available. No SSH credentials are
accepted. The OAuth scope bot_report.terminal remains for compatibility and
now authorizes **Worker execution only**.

## Worker and security boundaries

The Go Worker connects outbound over authenticated WSS, with its private
Ed25519 key stored locally. Install under a dedicated unprivileged account,
enroll with a one-time token and select only intended workspace roots.
The default Linux installer does not require sudo or install systemd.

**Shell access is OS-user authority. Allowed roots are not a shell sandbox.**
Use an independently configured OS/container sandbox for stronger isolation.
Start with read-only OAuth access, then grant terminal scope only to intended
clients and profiles. See [Worker lifecycle](worker/README.md),
[security model](docs/SECURITY_MODEL.md) and
[administration reference](docs/ADMIN_REFERENCE.md).

## Release status

GitHub `main` is the active source baseline. Docker `2.0.0-rc.2` is a
published Linux/amd64 **release candidate**, not a signed Go Worker release.
Local installation, database recovery and security tests have passed, but
cross-built Worker binaries do not establish native installer compatibility.
Worker distribution remains HTTP 503 pending approval; external HTTPS/OAuth
and independent offsite recovery are not release-certified. See the
[release checklist](docs/RELEASE_CHECKLIST.md) before any stable release.
