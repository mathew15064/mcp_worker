# System Task Daemon (worker_mcp) — mcp_worker Worker runtime

mcp_worker Worker now ships as a statically linked Go executable. The target machine does **not** need Node.js, npm, nvm, Python, Docker, or another language runtime. The Worker still initiates the outbound WebSocket connection to mcp_worker, so no inbound SSH port and no server-side SSH password are required.

## Supported standalone builds

mcp_worker ships standalone binaries for:

- Linux: `amd64`, `arm64`, `386`, `armv7`
- macOS: Intel `amd64`, Apple Silicon `arm64`
- Windows: `amd64`, `arm64`

Linux binaries use `CGO_ENABLED=0`, avoiding a target glibc dependency. macOS and Windows also require no Node.js, npm, Python, Go, Docker, or other language runtime on the target machine.

The retired Node Worker source and npm CLI are no longer shipped. Existing
Node Worker installations and saved identities are not modified by this source
cleanup. Migration to Go uses the compatible identity format. Use the approved signed GitHub Worker release; do not replace a running Worker with unsigned files.

## Install standalone Worker v2.0.0

The published [GitHub Release v2.0.0](https://github.com/mathew15064/mcp_worker/releases/tag/v2.0.0) includes signed assets for Linux (amd64, arm64, 386, armv7), macOS (amd64, arm64), and Windows (amd64, arm64), built from `165d41aa0ba0479e3b54cc5f9d6b31bb43a9f26e`. No Node.js, npm, Go, Python, or Docker is needed on the target. Linux/macOS require curl and OpenSSL; Windows requires PowerShell and OpenSSL on PATH.

**Linux:** Open **Workers → Install Worker → Linux** on the MCP Server and copy **Quick Install**. Its signed-release script runs from a unique `/tmp/mcp-worker-install.XXXXXX` directory and cleans the temp files; the binary, symlinks and identity stay under your user home. It adds `~/.local/bin` to your current shell PATH and to `~/.bashrc` exactly once. Use the **Advanced** steps to inspect the script before executing it.

For an existing manual installation with `mcp_worker: command not found`, run `export PATH="$HOME/.local/bin:$PATH"`. A new Bash session reads the persistent line in `~/.bashrc`. Run the complete Quick Install directly in your shell, not via `sh -c`, so the current-session export takes effect.

**macOS:**

```sh
curl -fsSLo install-macos.sh https://github.com/mathew15064/mcp_worker/releases/download/v2.0.0/install-macos.sh
sh install-macos.sh
```

**Windows PowerShell:**

```powershell
Invoke-WebRequest https://github.com/mathew15064/mcp_worker/releases/download/v2.0.0/install-windows.ps1 -OutFile install-windows.ps1
.\install-windows.ps1
```

The installers pin release version, source commit and RSA public key, and verify the signed nine-entry manifest and platform binary checksum before replacement. They expose `mcp_worker` as the standalone alias alongside compatible `worker_mcp`. Default install is user-mode without systemd.

**Enroll:** In the existing MCP Server's Admin → Workers page generate a one-time enrollment token. Run `mcp_worker setup --server https://YOUR_TRUSTED_MCP_SERVER` and enter the token when prompted. Do not pass tokens in command arguments or logs. Check `mcp_worker status`, `mcp_worker logs`, and Admin Workers for authenticated WSS; `mcp_worker connection test` checks HTTPS health/readiness only.

**Important:** `quick-setup.sh` installs the Docker MCP Server, **not** this standalone Worker. The Server's `/worker/install*` distribution routes still return HTTP 503. If Quick Setup detects existing Docker data/container without `.env.setup`, recover the original credentials and directory instead of deleting SQLite volumes. Native Windows/macOS installers passed simulation testing only; privileged Linux systemd lifecycle is not fully acceptance-tested.

## Upgrade and rollback

Run the matching installer again under the **same OS account**, with the same
server and installation paths. Manual installs preserve config and identity,
retain the last distinct binary under `previous/`, and reconnect if the Worker
was running. An identical download is a no-op and keeps the previous version.
The installer verifies the downloaded checksum before stopping the Worker.
If the replacement fails to reconnect, it attempts to restore and restart the
previous binary. Workloads/PTY sessions may be interrupted; schedule maintenance.

Manual rollback using an unsigned `previous/SHA256SUMS` file is
**disabled**. Keep a secure backup for operator-led recovery; restoring an
older signed release requires a separately reviewed release/pin change.
A stale .install-lock after interruption requires manual inspection.

Linux systemd is advanced opt-in:
`MCP_WORKER_WORKER_SYSTEMD=1 sh install-linux.sh` (after downloading and reviewing the v2.0.0 GitHub installer).
For a managed upgrade, the installer saves the previous installed binary,
root-owned unit, active/enabled status, local aliases, and signed release records
before changing the service. It installs the verified replacement, reloads the
unit and starts/restarts it; enrolled installations require a stable active
systemd MainPID before signed state is committed. Failure triggers automatic
restoration of the previous files, records and service state. Failed compensation
requires administrator recovery; recovery copies are retained and reported.
An identical healthy signed release is a no-op. Manual downgrades and manual
systemd rollback/uninstall still require separately reviewed administrative
maintenance; the manual installer refuses an existing systemd identity.
The local test uses an unprivileged disposable systemctl simulation; privileged
real systemd activation, reboot and recovery remain **NOT_TESTED**.
Do not run service installation against an unrelated existing service.
Under the owner-selected full-OS-account policy, the Worker inherits the privileges of the account running it (including root/Administrator if used). Installation and service accounts can differ; check the actual service identity before enabling remote execution.
macOS/Windows use manual mode; OS-native lifecycle tests remain a release gate.

## Signed release artifacts — approval required

The normative owner-operated RC checklist, key custody and root-rotation
policy are in [Signed Worker release and trust policy](../docs/WORKER_SIGNED_RELEASE_POLICY.md).

**Current release:** v2.0.0 is publicly available on GitHub with RSA-signed binaries and installer scripts. MCP Server-hosted `/worker/install*` routes remain HTTP 503; use GitHub Release assets, not the inactive server distribution endpoint. Old fail-closed RC templates remain historical/development-only. Do not disable signature verification.
All eight Linux/macOS/Windows Go binaries and `WORKER_RELEASE` are listed in
`SHA256SUMS`. `WORKER_RELEASE` has exactly two lines:
`version=x.y.z` and `commit=<full 40-character lowercase Git SHA>`. A detached
`SHA256SUMS.sig` signs the exact manifest using RSA/SHA-256. The installer
contains an independently reviewed, pinned RSA public verification key
(in base64 PEM form) and expected release version/commit. It verifies the
manifest signature **before** trusting any checksum; then checks metadata,
binary SHA-256, release identity, stored SPKI public-key fingerprint and monotonic installed version. An
unsigned, altered, wrong-key, wrong-version or older signed release is rejected
without replacing the running binary. `MCP_WORKER_WORKER_TRUSTED_KEY` is no
longer an override. All platforms require OpenSSL; Windows also requires
PowerShell. The Windows URL runs a single stage rather than executing an
unverified downloaded PowerShell payload.

Release candidate procedure (offline, only after human approval):

1. Build from an immutable reviewed commit with
   `VERSION=x.y.z COMMIT=<full-40-character-lowercase-commit> ./scripts/build-worker-go.sh`.
   Independently inspect `worker/bin/WORKER_RELEASE` and run
   `(cd worker/bin && sha256sum -c SHA256SUMS)`.
2. In an authorized offline signer environment, provide the **private**
   RSA key from a separate secure channel, not source, Actions secrets printed
   to logs, or the Docker image. The key must be a non-symlink regular file at
   an absolute path outside the checkout, with mode 0400 or 0600. CI never signs
   or uploads candidate binaries. Run
   `WORKER_RELEASE_EXPECTED_VERSION=x.y.z WORKER_RELEASE_EXPECTED_COMMIT=<full-40-character-commit> WORKER_RELEASE_EXPECTED_PUBLIC_KEY_SHA256=<independently-verified-SPKI-SHA256> ./scripts/sign-worker-manifest.sh /absolute/private.pem`.
   This tool refuses noncanonical or incomplete manifests and verifies its
   detached signature locally. It does **not** publish or approve a release.
3. Verify the signature independently with
   `openssl dgst -sha256 -verify public.pem -signature worker/bin/SHA256SUMS.sig worker/bin/SHA256SUMS`.
   Compare the public-key SPKI SHA-256 fingerprint through an **independent**
   owner-reviewed channel, and review the exact `version`, `commit` and
   `publicKeyBase64` values pinned by
   `APPROVED_WORKER_RELEASE` in `src/routes/workerRoutes.ts`.
   Until all three are approved and reviewed, this constant stays empty.
4. Run offline native lifecycle, malicious fixture and rollback tests on
   Linux, macOS and Windows; independently approve the release contents,
   recovery plan and distribution endpoints before enabling anything.
   Neither the manual artifact workflow nor tests create a public GitHub
   Release, tag, or trusted production key.

**Rollback policy:** manual `MCP_WORKER_WORKER_ACTION=rollback` is rejected,
including for older binaries with locally stored SHA256 checksums. An
automated start-failure recovery may restore the *previously running* binary
during a failed replacement; this is not permission to install an older
release. A deliberate downgrade requires separate owner approval and a
reviewed signed release policy change. Installer records
`release-version`/`release-commit` plus `release-key-sha256` beside the local
identity and denies
older signed packages and same-version/different-commit substitution.
A different signing public key is **not** an ordinary upgrade. One-way root
rotation is permitted only with an explicitly reviewed old SPKI SHA-256 pin
(`previousPublicKeySha256`) and a strictly greater version; arbitrary key
replacement, missing trust records, and key regression fail closed.
Legacy untracked binaries require an explicit migration rather than an
unverified in-place upgrade. Protect the installer source itself: its
download-channel authenticity is a separate bootstrap trust requirement,
so verify it via a trusted independent channel before execution.

## Login / enrollment

Run:

```bash
worker_mcp login
```

Interactive login asks for the one-time enrollment token and allowed workspace roots. The token input is hidden. It then:

1. generates an Ed25519 key pair locally,
2. sends only the public key to mcp_worker,
3. creates a Worker Profile alias automatically,
4. stores identity/config under `~/.worker_mcp/` with restrictive permissions,
5. starts the standalone Worker in the background,
6. waits until outbound WebSocket authentication succeeds before reporting `connected`.

Interactive shell PTYs are created on demand per profile and run as the OS account that started the Worker. No tmux session or inbound SSH connection is required.

When the server disables the owner/Worker, removes a persisted capability,
changes the Worker's authenticated owner or public key, cannot verify owner/Worker
status, or removes the Worker identity, an authenticated WebSocket revocation
stops the daemon and Worker-managed jobs,
processes and PTYs. It does **not** automatically reconnect;
restart deliberately only after the owner/identity is authorized again. Ordinary
network disconnects retain the normal reconnect behavior. If an offline Worker
receives HTTP 401/403 on its next authenticated handshake, or HTTP 503 with
WORKER_OWNER_UNAVAILABLE, it also stops managed workloads and does not retry.
Generic transient 502/503 failures still retry. Owner or Worker identity changes
made through another server instance are detected on the server's periodic
revalidation rather than instantaneously.

Non-interactive example:

```bash
worker_mcp login \
  --name 'Dev Laptop' \
  --profile 'Dev Laptop'
```

## Runtime commands

```bash
worker_mcp version
worker_mcp status
worker_mcp logs
worker_mcp stop
worker_mcp start
worker_mcp run
worker_mcp uninstall
```

Terminal operations use persistent local PTYs managed directly by the Worker. MCP terminal send/read/interrupt and browser **Attach Shell** share the same profile shell session without requiring tmux.

`uninstall` stops the local Worker and removes only the verified installer-managed runtime, local identity/config, and verified CLI symlink. Removing an online Worker from the mcp_worker web UI uses the same typed `worker.self_uninstall` control flow before deleting the server-side identity.

## Diagnose connectivity

Run `worker_mcp status` and `worker_mcp version` to identify the local profile,
runtime and process status; check Workers in Admin for actual server-side
online state. Use `worker_mcp logs` locally for TLS, authentication and
reconnection errors. Review logs before sharing them; do not share tokens,
private keys, configuration or workspace output. Verify the configured
server URL, DNS/TLS and outbound HTTPS/WSS connectivity. A running local
process does not prove an authenticated connection. If the previous binary
also fails to connect after restoration, leave the preserved identity/config
intact and diagnose the connection before starting again.

## Compatibility with existing Node Workers

The Go runtime intentionally uses the same JSON state/config schema and the same PKCS#8/SPKI Ed25519 PEM format as the Node runtime. Existing enrolled identities can therefore be upgraded in place:

```bash
curl -fsSLo install-linux.sh https://github.com/mathew15064/mcp_worker/releases/download/v2.0.0/install-linux.sh
sh install-linux.sh
worker_mcp start
```

No new enrollment token is required.

## Build

Go is a **build-time dependency only**. It is never required on a target Worker machine.

```bash
VERSION=2.0.0 COMMIT="$(git rev-parse HEAD)" ./scripts/build-worker-go.sh
```

Artifacts are written to `worker/bin/` for Linux (`amd64`, `arm64`, `386`, `armv7`), macOS (`amd64`, `arm64`), and Windows (`amd64`, `arm64`), together with `SHA256SUMS`. Generated binaries are intentionally excluded from Git and must be built as part of the deployment/release pipeline.

## Local security policy

The Worker keeps these settings in `~/.worker_mcp/config.json` and its Ed25519 private key in `~/.worker_mcp/state.json` (mode `0600` where supported):

```text
server_url             required mcp_worker HTTPS base URL
worker_name            worker identity display name
profile_name           MCP execution alias created during enrollment
tmux_session           terminal session used by terminal_* operations
allowed_roots          [] by default: any OS-accessible path; optional list restricts paths
allow_shell            true by default: shell/git/check/process as running OS account
allow_insecure_http    local/dev only; production should remain HTTPS/WSS
max_job_ms             local job timeout ceiling, max 300000
```

The owner selected unrestricted OS-account access for newly enrolled Workers. No `--roots` or `--allow-shell` flags are required: paths are governed by OS permissions and local shell execution is enabled. To intentionally restrict a Worker, supply `--roots` at enrollment; `MCP_WORKER_WORKER_ALLOW_SHELL=false` disables local shell execution. Existing installed Workers retain their saved settings until explicitly changed: set `allowed_roots` to `[]` and `allow_shell` to `true` in the local `config.json`, then restart the Worker. Running as Administrator/root grants that account's authority, including the ability to modify sensitive OS files. This choice does **not** disable owner authentication, Worker capabilities, OAuth scopes, key verification, or revocation.
