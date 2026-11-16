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

## Install from source (local Docker)

On Linux with Docker Engine, Compose v2, Git, OpenSSL, `flock` and Internet
access for the pinned build dependencies:

```sh
git clone https://github.com/mathew15064/mcp_worker.git
cd mcp_worker
./setup.sh --init
```

Open http://127.0.0.1:3333/admin as `admin`. The installer generates the
password and other persistent secrets in private `.env.setup`. **Do not
create a separate `.env` for Docker, expose the local HTTP port, or delete
data volumes.** Back up `.env.setup` and both named volumes together.

**Worker installer unavailable:** signed Go Worker distribution is not yet
approved; `/worker/install*` and `/worker/dist/*` return HTTP 503.
Do not bypass the signature gate.

For prerequisites, health checks, stopping/restarting, recovery and the
optional local OAuth call, follow the **[source installation quickstart](docs/QUICKSTART.md)**.
Manual Node development: [Admin reference](docs/ADMIN_REFERENCE.md#developer-setup).
Remote connections: [HTTPS and MCP](docs/REMOTE_MCP.md).

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
