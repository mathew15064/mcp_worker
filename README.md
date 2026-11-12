# mcp_worker

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

## Two-screen Vercel Quickstart (beta — not a production release)

[![Deploy to Vercel — development beta](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmathew15064%2Fmcp_worker%2Ftree%2Ffeature%2Fvercel-selfhost-20261112&project-name=mcp-worker-private&repository-name=mcp-worker-private&env=MCP_SETUP_SECRET&envDescription=Enter+one+freshly+generated+private+43-character+base64url+key.+Keep+it+in+your+password+manager%3B+it+protects+your+independent+instance.&envLink=https%3A%2F%2Fgithub.com%2Fmathew15064%2Fmcp_worker%2Fblob%2Ffeature%2Fvercel-selfhost-20261112%2Fdocs%2FVERCEL_QUICKSTART.md&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22integrationSlug%22%3A%22upstash%22%7D%5D)

**Deploy → Secure Setup → Dashboard.** Neon and Upstash are requested in
the Vercel Deploy flow. One private owner-generated key is entered during
Deploy and again when claiming the Admin account. The database and Redis
credentials are automatically injected; no SSH or manual `.env` editing.

[Read the two-screen guide](docs/VERCEL_QUICKSTART.md). Not yet suitable
for production until live Worker WSS and signed installer tests pass.

## Version and release policy

The published V2 main branch is the historical baseline; this Worker-only refactor exposes 15 MCP tools over outbound Go Worker transport. Stable releases will use versioned Git tags. This repository contains the V2 source release candidate. Public source access does not imply a stable signed release. See [the public release roadmap](docs/PUBLIC_RELEASE_ROADMAP.md).

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

## Vercel self-hosting (work in progress — not a release)

A separate Vercel/Neon/Upstash runtime is under development. It is
**not yet a one-click deploy template**: multi-instance Worker dispatch and
verified installer releases are still incomplete. No public Deploy Button is
published; do not use the Vercel prototype for production.

Read [the Vercel self-host development status](docs/VERCEL_SELFHOST_PREVIEW.md).
The stable Docker/VPS deployment path below is unchanged.

## Standalone Docker quickstart (local only)

On a Linux host with Docker Engine, Compose v2, Git, OpenSSL and flock:

```sh
./setup.sh --init
```

This builds the app and bundled MySQL 8.4.13 derivative locally and explicitly consents to initializing an empty dedicated database.
Open http://127.0.0.1:3333/admin. The initial admin username is `admin`; read
the generated password privately from `.env.setup` (mode 0600). Do not share
that file, logs containing credentials, or Docker inspect output. Back up the
env file and both named volumes together. The app binds loopback only, with
HTTP cookies suitable for local access. Remote MCP requires HTTPS and an
explicit public base URL; see [advanced proxy deployment](DOCKER_DEPLOYMENT.md).
Do not expose the standalone HTTP port remotely.

Rerun the same command to start again without replacing secrets or migrating
an existing database. Use `./setup.sh` to start without schema initialization;
existing/external databases use the Admin Test/Save/Initialize workflow.
If initialization fails or an existing database is not ready, inspect the
state and use the Admin recovery workflow; the script does not reset it.
`./setup.sh --down` stops the stack and retains volumes and credentials.
For isolated testing, set BOT_REPORT_SETUP_ENV=.env.setup-test,
BOT_REPORT_SETUP_PROJECT=mcp_worker-test and BOT_REPORT_SETUP_PORT=13333
on first run, and reuse the same env file thereafter.

## Getting Started — first authenticated call

After signing in, open **Getting Started** in Admin (or
`/admin/onboarding`). The six-step checklist reads current MySQL readiness,
MCP configuration, live global Worker profiles, active OAuth clients and
successful runtime_info audit evidence. Refresh after each step. It does
not change database configuration or issue credentials automatically.

For a local-only first call, create an Admin OAuth client with the exact
redirect URI `http://127.0.0.1:43871/callback` and only the
`bot_report.read` scope. Save the one-time secret privately. On the same
machine as the browser and standalone service, with Node.js 26 installed,
run:

```sh
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

Worker-only remains an unmerged source candidate. Linux standalone installation,
the historical 19 tools, Worker upgrade/rollback, and image vulnerability scanning have
been verified locally. Cross-built binaries do not establish native installer
compatibility. The [release checklist](docs/RELEASE_CHECKLIST.md) identifies
the remaining gates; third-party distribution review, signing
and external validation are required before publication.
