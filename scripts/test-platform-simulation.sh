#!/bin/sh
# Linux/WSL PC-only signed-installer simulations; no Windows/macOS VMs required.
# Cannot validate PE/Mach-O execution, Windows permissions, launchd or native ACLs.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
[ "$(uname -s)" = Linux ] || { echo '[platform-sim] requires Linux/WSL PC'; exit 2; }
for cmd in node npm curl sha256sum tar; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "[platform-sim] missing $cmd"; exit 2; }
done
if [ -n "${PWSH_BIN:-}" ]; then
  [ -x "$PWSH_BIN" ] || { echo '[platform-sim] PWSH_BIN is not executable'; exit 2; }
else
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/mcp_worker/platform-simulation/pwsh-7.7.0"
  PWSH_BIN="$CACHE/bin/pwsh"
  if [ ! -x "$PWSH_BIN" ]; then
    mkdir -p "$CACHE/bin"
    chmod 0700 "$CACHE"
    TAR_FILE="$CACHE/powershell-7.7.0-linux-x64.tar.gz"
    if [ ! -f "$TAR_FILE" ]; then
      curl -fL --retry 2 --connect-timeout 15 --max-time 120 --proto '=https' --proto-redir '=https' \
        'https://github.com/PowerShell/PowerShell/releases/download/v7.7.0/powershell-7.7.0-linux-x64.tar.gz' \
        -o "$TAR_FILE"
    fi
    printf 'c89d9c682d2c403dfe726f3df948e359675235a5bd6fab535776de69729ca0cb  %s\n' "$TAR_FILE" | sha256sum -c
    tar -xzf "$TAR_FILE" -C "$CACHE/bin"
    chmod 0700 "$PWSH_BIN"
  fi
fi
export PWSH_BIN
cd "$ROOT"
npm run build >/dev/null
for mac_arch in amd64 arm64; do
  echo "[platform-sim] macOS/$mac_arch: generated POSIX installer + signed stub"
  MACOS_QA_ARCH="$mac_arch" node scripts/test-simulated-macos-installer.cjs
done
for win_arch in amd64 arm64; do
  echo "[platform-sim] Windows/$win_arch: PowerShell Core + signed POSIX stub"
  WINDOWS_QA_ARCH="$win_arch" node scripts/test-simulated-windows-installer.cjs
done
echo '[platform-sim] 4 architecture suites PASS (28 simulated cases); native Windows/macOS acceptance NOT_TESTED'
echo '[platform-sim] production signing key unused, public release NO_GO'
