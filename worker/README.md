# System Task Daemon (systemtd) — mcp_worker Worker runtime

mcp_worker Worker now ships as a statically linked Go executable. The target machine does **not** need Node.js, npm, nvm, Python, Docker, or another language runtime. The Worker still initiates the outbound WebSocket connection to mcp_worker, so no inbound SSH port and no server-side SSH password are required.

## Supported standalone builds

mcp_worker ships standalone binaries for:

- Linux: `amd64`, `arm64`, `386`, `armv7`
- macOS: Intel `amd64`, Apple Silicon `arm64`
- Windows: `amd64`, `arm64`

Linux binaries use `CGO_ENABLED=0`, avoiding a target glibc dependency. macOS and Windows also require no Node.js, npm, Python, Go, Docker, or other language runtime on the target machine.

The legacy Node Worker source remains in `worker/` only as a rollback/compatibility implementation.

## Install

Generate a one-time enrollment token from **Workers**, then use the installer for the target OS.

Linux:

```bash
curl -fsSL https://bot-report.example.com/worker/install-linux.sh | sh
```

macOS:

```bash
curl -fsSL https://bot-report.example.com/worker/install-macos.sh | sh
```

Windows PowerShell:

```powershell
irm https://bot-report.example.com/worker/install.ps1 | iex
```

All installers download the matching binary from `/worker/dist/`, verify it against `SHA256SUMS`, preserve an existing Worker identity during upgrades, and print the next `login` or `start` command. Windows adds the managed `current` directory to the user PATH; Linux installs the OS-facing CLI as `systemtd` and keeps `bot-report-worker` as a compatibility symlink. The default is user-mode, without systemd or sudo. macOS keeps the standalone CLI flow for now.

## Upgrade and rollback

Run the matching installer again under the **same OS account**, with the same
server and installation paths. Manual installs preserve config and identity,
retain the last distinct binary under `previous/`, and reconnect if the Worker
was running. An identical download is a no-op and keeps the previous version.
The installer verifies the downloaded checksum before stopping the Worker.
If the replacement fails to reconnect, it attempts to restore and restart the
previous binary. Workloads/PTY sessions may be interrupted; schedule maintenance.

Linux/macOS manual rollback (from the same server):

```sh
curl -fsSL https://bot-report.example.com/worker/install-linux.sh -o /tmp/br-worker-install.sh
BOT_REPORT_WORKER_ACTION=rollback sh /tmp/br-worker-install.sh
```

Use install-macos.sh on macOS. Keep a trusted copy of the installer if offline
rollback is needed. Windows: set `$env:BOT_REPORT_WORKER_ACTION='rollback'`,
run the same PowerShell installer, then remove the environment variable.
The previous binary's local checksum is checked before rollback. Rollback
does not reset enrollment or change the server; it swaps the current and
previous binaries. Keep an independent backup of identity/config and binaries
before maintenance. A stale .install-lock after interruption requires manual
inspection before removal.

Linux systemd is advanced opt-in:
`curl .../worker/install-linux.sh | BOT_REPORT_WORKER_SYSTEMD=1 sh`.
Managed service rollback/uninstall needs explicit administrative maintenance;
the manual installer refuses to operate on an existing systemd identity.
Do not run service installation against an unrelated existing service.
User-mode Workers should be run by a dedicated low-privilege OS user; running the installer/login as root still gives the Worker root authority.
macOS/Windows use manual mode; OS-native lifecycle tests remain a release gate.

## Signed release artifacts

Builds include version and commit in WORKER_RELEASE, whose checksum is covered by SHA256SUMS. In an authorized
signing environment run `scripts/sign-worker-manifest.sh /absolute/private-key.pem`
with an owner-controlled RSA or ECDSA signing key. Publish the signature,
manifest, WORKER_RELEASE and matching binaries together. Never embed the private key in the
repository or Docker image. On a target machine, obtain the public key through
a separate trusted channel and set `BOT_REPORT_WORKER_TRUSTED_KEY` to its
local path before running the installer. This opt-in requires OpenSSL and
fails closed if the signature is missing or invalid. Without a trusted key,
checksum verification provides integrity but not independent authenticity.
Use HTTPS for remote downloads. Signed public releases and key provisioning
remain a release gate; local builds are not signed by default.

## Login / enrollment

Run:

```bash
systemtd login
```

Interactive login asks for the one-time enrollment token and allowed workspace roots. The token input is hidden. It then:

1. generates an Ed25519 key pair locally,
2. sends only the public key to mcp_worker,
3. creates a Worker Profile alias automatically,
4. stores identity/config under `~/.bot-report-worker/` with restrictive permissions,
5. starts the standalone Worker in the background,
6. waits until outbound WebSocket authentication succeeds before reporting `connected`.

Interactive shell PTYs are created on demand per profile and run as the OS account that started the Worker. No tmux session or inbound SSH connection is required.

Non-interactive example:

```bash
systemtd login \
  --token 'br_enroll_...' \
  --roots '/home/me/work,/srv/projects' \
  --name 'Dev Laptop' \
  --profile 'Dev Laptop' \
  --allow-shell
```

## Runtime commands

```bash
systemtd version
systemtd status
systemtd logs
systemtd stop
systemtd start
systemtd run
systemtd uninstall
```

Terminal operations use persistent local PTYs managed directly by the Worker. MCP terminal send/read/interrupt and browser **Attach Shell** share the same profile shell session without requiring tmux.

`uninstall` stops the local Worker and removes only the verified installer-managed runtime, local identity/config, and verified CLI symlink. Removing an online Worker from the mcp_worker web UI uses the same typed `worker.self_uninstall` control flow before deleting the server-side identity.

## Diagnose connectivity

Run `systemtd status` and `systemtd version` to identify the local profile,
runtime and process status; check Workers in Admin for actual server-side
online state. Use `systemtd logs` locally for TLS, authentication and
reconnection errors. Review logs before sharing them; do not share tokens,
private keys, configuration or workspace output. Verify the configured
server URL, DNS/TLS and outbound HTTPS/WSS connectivity. A running local
process does not prove an authenticated connection. If the previous binary
also fails to connect after restoration, leave the preserved identity/config
intact and diagnose the connection before starting again.

## Compatibility with existing Node Workers

The Go runtime intentionally uses the same JSON state/config schema and the same PKCS#8/SPKI Ed25519 PEM format as the Node runtime. Existing enrolled identities can therefore be upgraded in place:

```bash
curl -fsSL https://bot-report.example.com/worker/install.sh | sh
systemtd start
```

No new enrollment token is required.

## Build

Go is a **build-time dependency only**. It is never required on a target Worker machine.

```bash
GO_BIN=/path/to/go ./scripts/build-worker-go.sh
```

Artifacts are written to `worker/bin/` for Linux (`amd64`, `arm64`, `386`, `armv7`), macOS (`amd64`, `arm64`), and Windows (`amd64`, `arm64`), together with `SHA256SUMS`. Generated binaries are intentionally excluded from Git and must be built as part of the deployment/release pipeline.

## Local security policy

The Worker keeps these settings in `~/.bot-report-worker/config.json` and its Ed25519 private key in `~/.bot-report-worker/state.json` (mode `0600` where supported):

```text
server_url             required mcp_worker HTTPS base URL
worker_name            worker identity display name
profile_name           MCP execution alias created during enrollment
tmux_session           terminal session used by terminal_* operations
allowed_roots          local workspace roots accepted by path-bearing operations
allow_shell            explicit local opt-in for shell/git/check/process execution
allow_insecure_http    local/dev only; production should remain HTTPS/WSS
max_job_ms             local job timeout ceiling, max 300000
```

The server cannot remotely expand allowed roots, enable shell execution, or obtain the Worker private key. `allow_shell=true` grants mcp_worker the same shell authority as the OS account running the Worker, so use a dedicated low-privilege account or OS/container sandbox when stronger isolation is required.
