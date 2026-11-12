import express, { type Request } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { rateLimit } from 'express-rate-limit';
import databaseManager from '../db/databaseManager';
import workerAuthService from '../services/workerAuthService';
import workerRepository from '../repositories/workerRepository';
import { canonicalVercelOrigin } from '../config/managedStorage';
import { canonicalRailwayOrigin } from '../config/railwayOrigin';

// No approved signing key/release exists. Populate only by reviewed code change.
type ApprovedWorkerRelease = Readonly<{
  version: string;
  commit: string;
  publicKeyBase64: string;
}>;
const APPROVED_WORKER_RELEASE: ApprovedWorkerRelease = Object.freeze({
  version: '',
  commit: '',
  publicKeyBase64: '',
});

const router = express.Router();
const WORKER_DIR = path.resolve(__dirname, '../../worker');
const WORKER_BIN_DIR = path.join(WORKER_DIR, 'bin');
const LEGACY_DIST_FILES = Object.freeze([
  'agent.js',
  'cli.js',
  'lifecycle.js',
  'package.json',
  'package-lock.json',
]);
const BINARY_DIST_FILES = Object.freeze([
  'bot-report-worker-linux-amd64',
  'bot-report-worker-linux-arm64',
  'bot-report-worker-linux-386',
  'bot-report-worker-linux-armv7',
  'bot-report-worker-darwin-amd64',
  'bot-report-worker-darwin-arm64',
  'bot-report-worker-windows-amd64.exe',
  'bot-report-worker-windows-arm64.exe',
]);
const DIST_FILES = Object.freeze([...LEGACY_DIST_FILES, ...BINARY_DIST_FILES]);

const enrollmentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function publicBaseUrl(req: Request) {
  // Never let a caller-controlled Host/X-Forwarded-Host select the endpoint
  // from which a Vercel owner will download and execute a Worker installer.
  if (process.env.MCP_PLATFORM === 'vercel') {
    const origin = canonicalVercelOrigin();
    if (!origin) throw new Error('Missing canonical Vercel origin for Worker installer.');
    return origin;
  }
  if (process.env.MCP_PLATFORM === 'railway') {
    const origin = canonicalRailwayOrigin();
    if (!origin) throw new Error('Missing canonical Railway origin for Worker installer.');
    return origin;
  }
  const value = `${req.protocol}://${req.get('host')}`;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('Unsupported installer origin.');
  return parsed.origin;
}

function shellSingleQuote(value: string) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function unixInstallerScript(
  baseUrl: string,
  expectedOS: string,
  approved: ApprovedWorkerRelease = APPROVED_WORKER_RELEASE,
) {
  const base = shellSingleQuote(baseUrl);
  const osName = shellSingleQuote(expectedOS);
  const pinnedVersion = shellSingleQuote(approved.version);
  const pinnedCommit = shellSingleQuote(approved.commit);
  const pinnedKey = shellSingleQuote(approved.publicKeyBase64);
  return `#!/bin/sh
set -eu

BASE_URL=${base}
EXPECTED_OS=${osName}
PINNED_VERSION=${pinnedVersion}
PINNED_COMMIT=${pinnedCommit}
PINNED_PUBLIC_KEY_B64=${pinnedKey}
INSTALL_ROOT="${'${BOT_REPORT_WORKER_INSTALL_ROOT:-$HOME/.local/share/bot-report-worker}'}"
BIN_DIR="${'${BOT_REPORT_WORKER_BIN_DIR:-$HOME/.local/bin}'}"
WORKER_HOME="${'${BOT_REPORT_WORKER_HOME:-$HOME/.bot-report-worker}'}"
TARGET="$INSTALL_ROOT/current"
SYSTEMTD="$TARGET/systemtd"
TMP="$(mktemp -d)"
LOCK=""
cleanup() { rm -rf "$TMP"; if [ -n "$LOCK" ]; then rmdir "$LOCK" 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
ACTION="${'${BOT_REPORT_WORKER_ACTION:-install}'}"
SERVICE="${'${BOT_REPORT_WORKER_SYSTEMD:-0}'}"
if [ "${'${BOT_REPORT_WORKER_SKIP_SERVICE:-0}'}" = 1 ]; then SERVICE=0; fi
case "$SERVICE" in 0|1) ;; *) echo "[systemtd] invalid service mode" >&2; exit 1;; esac
case "$ACTION" in install|rollback) ;; *) echo "[systemtd] invalid action" >&2; exit 1;; esac
if [ -f "$WORKER_HOME/service-mode" ] && [ "$(cat "$WORKER_HOME/service-mode")" = systemd ] && [ "$SERVICE" != 1 ]; then
  echo "[systemtd] managed service detected; use explicit systemd maintenance, not manual installer." >&2; exit 1
fi
if [ "$ACTION" = rollback ] && [ "$SERVICE" = 1 ]; then
  echo "[systemtd] manual rollback is not supported for systemd; use administrative recovery." >&2; exit 1
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "[systemtd] missing required command: $1" >&2; exit 1; }; }
need curl
need uname
need id
need openssl
[ -n "$PINNED_VERSION" ] && [ -n "$PINNED_COMMIT" ] && [ -n "$PINNED_PUBLIC_KEY_B64" ] || {
  echo "[systemtd] signed release not approved" >&2; exit 1;
}
case "$PINNED_VERSION" in *[!0-9.]*|'') echo "[systemtd] invalid release version" >&2; exit 1;; esac
case "$PINNED_COMMIT" in *[!0-9a-f]*|'') echo "[systemtd] invalid release commit" >&2; exit 1;; esac
if [ "$ACTION" = rollback ]; then
  echo "[systemtd] manual rollback prohibited; explicitly approve a signed release" >&2
  exit 1
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"
if [ "$OS" != "$EXPECTED_OS" ]; then
  echo "[systemtd] this installer is for $EXPECTED_OS; detected $OS." >&2
  exit 1
fi
case "$OS:$ARCH_RAW" in
  linux:x86_64|linux:amd64|darwin:x86_64|darwin:amd64) ARCH="amd64" ;;
  linux:aarch64|linux:arm64|darwin:aarch64|darwin:arm64) ARCH="arm64" ;;
  linux:i386|linux:i486|linux:i586|linux:i686) ARCH="386" ;;
  linux:armv7l|linux:armv7*) ARCH="armv7" ;;
  *) echo "[systemtd] unsupported platform: $OS/$ARCH_RAW" >&2; exit 1 ;;
esac
FILE="bot-report-worker-$OS-$ARCH"

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
if [ -L "$INSTALL_ROOT" ] || [ -L "$TARGET" ] || [ -L "$SYSTEMTD" ] || [ -L "$WORKER_HOME" ] || [ -L "$INSTALL_ROOT/previous" ]; then
  echo "[systemtd] symlink installation refused" >&2; exit 1
fi
if [ -f "$WORKER_HOME/install-root" ] && [ "$(cat "$WORKER_HOME/install-root")" != "$INSTALL_ROOT" ]; then
  echo "[systemtd] existing identity belongs to a different install root" >&2; exit 1
fi
if [ -f "$WORKER_HOME/default-server" ] && [ "$(cat "$WORKER_HOME/default-server")" != "$BASE_URL" ]; then
  echo "[systemtd] existing installation belongs to a different server" >&2; exit 1
fi
mkdir "$INSTALL_ROOT/.install-lock" || { echo "[systemtd] installer already running or stale lock; inspect before removal" >&2; exit 1; }
LOCK="$INSTALL_ROOT/.install-lock"
PREVIOUS="$INSTALL_ROOT/previous"
printf '%s' "$PINNED_PUBLIC_KEY_B64" | openssl base64 -d -A > "$TMP/release-key.pem"
openssl rsa -pubin -in "$TMP/release-key.pem" -noout >/dev/null 2>&1 || {
  echo "[systemtd] invalid pinned RSA public key" >&2; exit 1;
}
curl -fsSL "$BASE_URL/worker/dist/SHA256SUMS" -o "$TMP/SHA256SUMS"
curl -fsSL "$BASE_URL/worker/dist/SHA256SUMS.sig" -o "$TMP/SHA256SUMS.sig"
openssl dgst -sha256 -verify "$TMP/release-key.pem" -signature "$TMP/SHA256SUMS.sig" "$TMP/SHA256SUMS" >/dev/null || {
  echo "[systemtd] signature verification failed" >&2; exit 1;
}
manifest_hash() {
  awk -v file="$1" '
    $2 == file { count++; value=$1 }
    END {
      if (count != 1 || length(value) != 64 || value ~ /[^0-9a-fA-F]/) exit 1
      print tolower(value)
    }' "$TMP/SHA256SUMS"
}
RELEASE_HASH="$(manifest_hash WORKER_RELEASE)" || { echo "[systemtd] missing or duplicate release checksum" >&2; exit 1; }
curl -fsSL "$BASE_URL/worker/dist/WORKER_RELEASE" -o "$TMP/WORKER_RELEASE"
ACTUAL_RELEASE="$(openssl dgst -sha256 "$TMP/WORKER_RELEASE" | awk '{print $NF}')"
[ "$ACTUAL_RELEASE" = "$RELEASE_HASH" ] || { echo "[systemtd] release metadata checksum failed" >&2; exit 1; }
[ "$(wc -l < "$TMP/WORKER_RELEASE" | tr -d ' ')" = 2 ] &&
  [ "$(sed -n '1p' "$TMP/WORKER_RELEASE")" = "version=$PINNED_VERSION" ] &&
  [ "$(sed -n '2p' "$TMP/WORKER_RELEASE")" = "commit=$PINNED_COMMIT" ] || {
  echo "[systemtd] signed release version/commit mismatch" >&2; exit 1;
}
RECORDED_VERSION="$WORKER_HOME/release-version"
RECORDED_COMMIT="$WORKER_HOME/release-commit"
if [ -f "$SYSTEMTD" ] && [ ! -f "$RECORDED_VERSION" ]; then
  echo "[systemtd] existing runtime lacks verified release record" >&2; exit 1
fi
if [ -e "$RECORDED_VERSION" ] || [ -e "$RECORDED_COMMIT" ]; then
  [ -f "$RECORDED_VERSION" ] && [ -f "$RECORDED_COMMIT" ] &&
    [ ! -L "$RECORDED_VERSION" ] && [ ! -L "$RECORDED_COMMIT" ] || {
    echo "[systemtd] incomplete or unsafe release record" >&2; exit 1;
  }
  OLD_VERSION="$(cat "$RECORDED_VERSION")"
  OLD_COMMIT="$(cat "$RECORDED_COMMIT")"
  awk -v old="$OLD_VERSION" -v new="$PINNED_VERSION" 'BEGIN {
    if (old !~ /^[0-9]+\\.[0-9]+\\.[0-9]+$/ || new !~ /^[0-9]+\\.[0-9]+\\.[0-9]+$/) exit 1
    split(old,a,"."); split(new,b,".")
    for (i=1;i<=3;i++) {
      if (b[i]+0<a[i]+0) exit 1
      if (b[i]+0>a[i]+0) exit 0
    }
  }' || { echo "[systemtd] signed release rollback rejected" >&2; exit 1; }
  if [ "$OLD_VERSION" = "$PINNED_VERSION" ] && [ "$OLD_COMMIT" != "$PINNED_COMMIT" ]; then
    echo "[systemtd] release version reused for another commit" >&2; exit 1
  fi
fi
curl -fsSL "$BASE_URL/worker/dist/$FILE" -o "$TMP/systemtd"
EXPECTED="$(manifest_hash "$FILE")" || { echo "[systemtd] missing or duplicate binary checksum" >&2; exit 1; }
if [ -z "$EXPECTED" ]; then
  echo "[systemtd] checksum manifest does not contain $FILE." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/systemtd" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP/systemtd" | awk '{print $1}')"
elif command -v openssl >/dev/null 2>&1; then
  ACTUAL="$(openssl dgst -sha256 "$TMP/systemtd" | awk '{print $NF}')"
else
  echo "[systemtd] sha256sum, shasum, or openssl is required for download verification." >&2
  exit 1
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "[systemtd] checksum verification failed for $FILE." >&2
  exit 1
fi
chmod 0755 "$TMP/systemtd"
"$TMP/systemtd" version >/dev/null

SERVICE_ACTIVE=0
if [ "$OS" = linux ] && [ "$SERVICE" = 1 ]; then
  need systemctl
  if [ "$(id -u)" -ne 0 ]; then need sudo; sudo -n true >/dev/null 2>&1 || { echo "[systemtd] systemd requires passwordless sudo" >&2; exit 1; }; fi
  if systemctl cat systemtd.service >/dev/null 2>&1; then
    [ -f "$WORKER_HOME/service-mode" ] && [ "$(cat "$WORKER_HOME/service-mode")" = systemd ] || { echo "[systemtd] existing systemd unit belongs to another installation" >&2; exit 1; }
  fi
  if systemctl is-active --quiet systemtd.service 2>/dev/null; then
    [ -f "$WORKER_HOME/service-mode" ] && [ "$(cat "$WORKER_HOME/service-mode")" = systemd ] || { echo "[systemtd] another system service is active; refusing" >&2; exit 1; }
    SERVICE_ACTIVE=1
  fi
fi

for ALIAS in "$BIN_DIR/systemtd" "$BIN_DIR/bot-report-worker"; do
  if [ -e "$ALIAS" ] || [ -L "$ALIAS" ]; then
    [ -L "$ALIAS" ] && { [ "$(readlink "$ALIAS")" = "$SYSTEMTD" ] || [ "$(readlink "$ALIAS")" = "$TARGET/bot-report-worker" ]; } || { echo "[systemtd] unrelated CLI path exists: $ALIAS" >&2; exit 1; }
  fi
done
if [ "$SERVICE" = 0 ] && [ "$ACTION" = install ] && [ -f "$SYSTEMTD" ] && cmp -s "$SYSTEMTD" "$TMP/systemtd"; then
  echo "[systemtd] runtime already current; identity and rollback retained"
  exit 0
fi
WAS_RUNNING=0
if [ "$SERVICE_ACTIVE" -eq 0 ]; then
  for LEGACY in "$BIN_DIR/bot-report-worker" "$TARGET/bot-report-worker" "$SYSTEMTD"; do
    if [ -x "$LEGACY" ]; then
      if "$LEGACY" status 2>/dev/null | grep -q 'status: RUNNING'; then WAS_RUNNING=1; fi
      "$LEGACY" stop >/dev/null
      break
    fi
  done
fi
mkdir -p "$TARGET"
# Retain the running binary until a verified replacement has been staged.
if [ -f "$SYSTEMTD" ]; then
  cp "$SYSTEMTD" "$TMP/old"

fi
NEXT="$(mktemp "$TARGET/.systemtd.XXXXXX")"
cp "$TMP/systemtd" "$NEXT"
chmod 0755 "$NEXT"
mv -f "$NEXT" "$SYSTEMTD"
ln -sfn "$TARGET/systemtd" "$BIN_DIR/systemtd"
ln -sfn "$TARGET/systemtd" "$BIN_DIR/bot-report-worker"

mkdir -p "$WORKER_HOME"
[ -f "$WORKER_HOME/default-server" ] || printf '%s\n' "$BASE_URL" > "$WORKER_HOME/default-server"
printf '%s\n' "$INSTALL_ROOT" > "$WORKER_HOME/install-root"
printf '%s\n' "$BIN_DIR/systemtd" > "$WORKER_HOME/bin-path"
chmod 0700 "$WORKER_HOME"
chmod 0600 "$WORKER_HOME/default-server" "$WORKER_HOME/install-root" "$WORKER_HOME/bin-path"
printf '%s\\n' "$PINNED_VERSION" > "$WORKER_HOME/release-version"
printf '%s\\n' "$PINNED_COMMIT" > "$WORKER_HOME/release-commit"
chmod 0600 "$WORKER_HOME/release-version" "$WORKER_HOME/release-commit"

echo "[systemtd] installed standalone runtime: $BIN_DIR/systemtd ($OS/$ARCH)"

if [ "$OS" = linux ] && [ "$SERVICE" = 1 ]; then
  RUN_USER="$(id -un)"
  RUN_GROUP="$(id -gn)"
  RUN_HOME="$HOME"
  if [ "$(id -u)" -eq 0 ]; then
    root_cmd() { "$@"; }
  else
    need sudo
    sudo -n true >/dev/null 2>&1 || { echo "[systemtd] Linux system service installation requires root or passwordless sudo." >&2; exit 1; }
    root_cmd() { sudo -n "$@"; }
  fi
  SYSTEMD_VERSION="$(systemctl --version 2>/dev/null | awk 'NR==1 { print $2 }')"
  MEMORY_DIRECTIVE=MemoryLimit
  case "$SYSTEMD_VERSION" in
    ''|*[!0-9]*) ;;
    *) if [ "$SYSTEMD_VERSION" -ge 231 ]; then MEMORY_DIRECTIVE=MemoryMax; fi ;;
  esac
  cat > "$TMP/systemtd.service" <<UNIT
[Unit]
Description=mcp_worker System Task Daemon
After=network-online.target
Wants=network-online.target
RefuseManualStop=yes

[Service]
Type=simple
StartLimitInterval=60
StartLimitBurst=5
User=$RUN_USER
Group=$RUN_GROUP
Environment="HOME=$RUN_HOME"
Environment="BOT_REPORT_WORKER_HOME=$WORKER_HOME"
ExecStart=/usr/local/sbin/systemtd run
Restart=always
RestartSec=3
TimeoutStopSec=10
$MEMORY_DIRECTIVE=512M
TasksMax=128

[Install]
WantedBy=multi-user.target
UNIT
  SYSTEM_BIN_NEXT="/usr/local/sbin/.systemtd.next.$$"
  root_cmd install -m 0755 "$SYSTEMTD" "$SYSTEM_BIN_NEXT"
  root_cmd mv -f "$SYSTEM_BIN_NEXT" /usr/local/sbin/systemtd
  root_cmd install -m 0644 "$TMP/systemtd.service" /etc/systemd/system/systemtd.service
  root_cmd systemctl daemon-reload
  root_cmd systemctl enable systemtd.service >/dev/null
  printf '%s\n' systemd > "$WORKER_HOME/service-mode"
  chmod 0600 "$WORKER_HOME/service-mode"
  if [ -f "$WORKER_HOME/state.json" ]; then
    if [ "$SERVICE_ACTIVE" -eq 1 ]; then
      root_cmd systemctl kill --kill-who=main --signal=TERM systemtd.service
    else
      root_cmd systemctl start systemtd.service
    fi
    i=0
    while [ "$i" -lt 40 ]; do
      if root_cmd systemctl is-active --quiet systemtd.service; then break; fi
      i=$((i + 1))
      sleep 0.25
    done
    root_cmd systemctl is-active --quiet systemtd.service || { echo "[systemtd] systemtd.service failed to become active." >&2; exit 1; }
    echo "[systemtd] systemd service enabled and active"
  else
    echo "[systemtd] systemd service installed; enroll first with: systemtd login"
  fi
fi

# Manual installs restore the prior running state and fail back on connection failure.
if [ "$SERVICE" = 0 ] && [ "$WAS_RUNNING" = 1 ]; then
  if ! "$SYSTEMTD" start; then
    "$SYSTEMTD" stop >/dev/null 2>&1 || true
    if [ -f "$TMP/old" ]; then
      NEXT="$(mktemp "$TARGET/.systemtd.XXXXXX")"
      cp "$TMP/old" "$NEXT"
      chmod 0755 "$NEXT"
      mv -f "$NEXT" "$SYSTEMTD"
      "$SYSTEMTD" start || true
    fi
    echo "[systemtd] replacement failed; previous binary restored when available" >&2
    exit 1
  fi
fi
if [ -f "$TMP/old" ]; then
  mkdir -p "$PREVIOUS"
  NEXT="$(mktemp "$PREVIOUS/.systemtd.XXXXXX")"
  cp "$TMP/old" "$NEXT"
  chmod 0755 "$NEXT"
  mv -f "$NEXT" "$PREVIOUS/systemtd"
  if command -v sha256sum >/dev/null 2>&1; then OLD_HASH="$(sha256sum "$PREVIOUS/systemtd" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then OLD_HASH="$(shasum -a 256 "$PREVIOUS/systemtd" | awk '{print $1}')"
  else OLD_HASH="$(openssl dgst -sha256 "$PREVIOUS/systemtd" | awk '{print $NF}')"; fi
  printf '%s  %s\n' "$OLD_HASH" "$FILE" > "$PREVIOUS/SHA256SUMS"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "[systemtd] add $BIN_DIR to PATH if needed." ;;
esac
if [ -f "$WORKER_HOME/state.json" ]; then
  if [ "$OS" = linux ] && [ "$SERVICE" = 1 ]; then
    echo "[systemtd] existing identity preserved; service: systemtd.service"
  else
    echo "[systemtd] existing identity preserved; next: systemtd start"
  fi
else
  echo "[systemtd] next: systemtd login"
fi
`;
}

function installerScript(baseUrl: string, approved?: ApprovedWorkerRelease) {
  return unixInstallerScript(baseUrl, 'linux', approved);
}
function macInstallerScript(baseUrl: string, approved?: ApprovedWorkerRelease) {
  return unixInstallerScript(baseUrl, 'darwin', approved);
}
function powershellSingleQuote(value: string) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
// No unsigned second-stage PowerShell downloader.
function windowsInstallerScript(baseUrl: string, approved?: ApprovedWorkerRelease) {
  return windowsInstallerPayloadScript(baseUrl, approved);
}

function windowsInstallerPayloadScript(
  baseUrl: string,
  approved: ApprovedWorkerRelease = APPROVED_WORKER_RELEASE,
) {
  const base = powershellSingleQuote(baseUrl);
  const pinnedVersion = powershellSingleQuote(approved.version);
  const pinnedCommit = powershellSingleQuote(approved.commit);
  const pinnedKey = powershellSingleQuote(approved.publicKeyBase64);
  return `$ErrorActionPreference = 'Stop'
$BaseUrl = ${base}
$PinnedVersion = ${pinnedVersion}
$PinnedCommit = ${pinnedCommit}
$PinnedPublicKeyB64 = ${pinnedKey}
if (-not $PinnedVersion -or -not $PinnedCommit -or -not $PinnedPublicKeyB64) { throw 'Signed release not approved' }
if ($PinnedVersion -cnotmatch '^[0-9]+\\.[0-9]+\\.[0-9]+ = if ($env:BOT_REPORT_WORKER_INSTALL_ROOT) { $env:BOT_REPORT_WORKER_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'BotReportWorker' }
$Target = Join-Path $InstallRoot 'current'
$Previous = Join-Path $InstallRoot 'previous'
$Action = if ($env:BOT_REPORT_WORKER_ACTION) { $env:BOT_REPORT_WORKER_ACTION } else { 'install' }
if ($Action -notin @('install','rollback')) { throw 'Invalid installer action' }
if ($Action -eq 'rollback') { throw 'Manual rollback prohibited; explicitly approve signed release' }
$WorkerHome = if ($env:BOT_REPORT_WORKER_HOME) { $env:BOT_REPORT_WORKER_HOME } else { Join-Path $HOME '.bot-report-worker' }
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('bot-report-worker-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Lock = Join-Path $InstallRoot '.install-lock'
$LockOwned = $false
try {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  foreach ($Path in @($InstallRoot, $Target, $Previous, $WorkerHome)) {
    if ((Test-Path $Path) -and ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse point installation refused' }
  }
  $RecordedRoot = Join-Path $WorkerHome 'install-root'
  $RecordedServer = Join-Path $WorkerHome 'default-server'
  if ((Test-Path $RecordedRoot) -and ((Get-Content $RecordedRoot -Raw).Trim() -ne $InstallRoot)) { throw 'Different existing installation root' }
  if ((Test-Path $RecordedServer) -and ((Get-Content $RecordedServer -Raw).Trim() -ne $BaseUrl)) { throw 'Different existing server' }
  New-Item -ItemType Directory -Path $Lock -ErrorAction Stop | Out-Null
  $LockOwned = $true
  $ArchRaw = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($ArchRaw) {
    'x64' { $Arch = 'amd64' }
    'arm64' { $Arch = 'arm64' }
    default { throw "Unsupported Windows architecture: $ArchRaw" }
  }
  $File = "bot-report-worker-windows-$Arch.exe"
  $Downloaded = Join-Path $Tmp 'bot-report-worker.exe'
  $Sums = Join-Path $Tmp 'SHA256SUMS'
  $Signature = Join-Path $Tmp 'SHA256SUMS.sig'
  $KeyPath = Join-Path $Tmp 'release-key.pem'
  $Metadata = Join-Path $Tmp 'WORKER_RELEASE'
  [IO.File]::WriteAllBytes($KeyPath, [Convert]::FromBase64String($PinnedPublicKeyB64))
  & openssl rsa -pubin -in $KeyPath -noout 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Invalid pinned RSA public key' }
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/SHA256SUMS" -OutFile $Sums
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/SHA256SUMS.sig" -OutFile $Signature
  & openssl dgst -sha256 -verify $KeyPath -signature $Signature $Sums | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Manifest signature verification failed' }
  $Entries = @(Get-Content $Sums | ForEach-Object {
    if ($_ -cnotmatch '^([0-9a-fA-F]{64})  (.+)$') { throw 'Malformed checksum manifest' }
    [pscustomobject]@{ Hash = $Matches[1].ToLowerInvariant(); Name = $Matches[2] }
  })
  function ExpectedHash([string]$Name) {
    $Found = @($Entries | Where-Object { $_.Name -ceq $Name })
    if ($Found.Count -ne 1) { throw "Missing or duplicate checksum: $Name" }
    return $Found[0].Hash
  }
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/WORKER_RELEASE" -OutFile $Metadata
  if ((Get-FileHash -Algorithm SHA256 $Metadata).Hash.ToLowerInvariant() -cne (ExpectedHash 'WORKER_RELEASE')) {
    throw 'Release metadata checksum failed'
  }
  $ReleaseLines = @(Get-Content $Metadata)
  if ($ReleaseLines.Count -ne 2 -or $ReleaseLines[0] -cne "version=$PinnedVersion" -or $ReleaseLines[1] -cne "commit=$PinnedCommit") {
    throw 'Signed release version/commit mismatch'
  }
  $VersionPath = Join-Path $WorkerHome 'release-version'
  $CommitPath = Join-Path $WorkerHome 'release-commit'
  $Existing = Join-Path $Target 'bot-report-worker.exe'
  if ((Test-Path $Existing) -and -not (Test-Path $VersionPath)) { throw 'Existing runtime lacks verified release record' }
  if ((Test-Path $VersionPath) -or (Test-Path $CommitPath)) {
    if (-not (Test-Path $VersionPath) -or -not (Test-Path $CommitPath)) { throw 'Incomplete release record' }
    foreach ($Record in @($VersionPath,$CommitPath)) {
      if ((Get-Item -LiteralPath $Record).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe release record' }
    }
    $OldVersion = (Get-Content $VersionPath -Raw).Trim()
    $OldCommit = (Get-Content $CommitPath -Raw).Trim()
    if ($OldVersion -notmatch '^[0-9]+\\.[0-9]+\\.[0-9]+$') { throw 'Malformed release record' }
    if ([version]$PinnedVersion -lt [version]$OldVersion) { throw 'Signed release rollback rejected' }
    if ($OldVersion -ceq $PinnedVersion -and $OldCommit -cne $PinnedCommit) { throw 'Release version reused for another commit' }
  }
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/$File" -OutFile $Downloaded
  $Expected = ExpectedHash $File
  $Actual = (Get-FileHash -Algorithm SHA256 $Downloaded).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected.ToLowerInvariant()) { throw "Checksum verification failed for $File" }

  & $Downloaded version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Downloaded runtime failed version check' }
  $Existing = Join-Path $Target 'bot-report-worker.exe'
  $Old = Join-Path $Tmp 'old.exe'
  $Next = Join-Path $Target ('.next-' + [guid]::NewGuid().ToString('N') + '.exe')
  if ((Test-Path $Existing) -and ($Action -eq 'install') -and ((Get-FileHash -Algorithm SHA256 $Existing).Hash.ToLowerInvariant() -eq $Actual)) {
    Write-Host '[bot-report-worker] runtime already current; rollback retained'
    return
  }
  $WasRunning = $false
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  if (Test-Path $Existing) {
    Copy-Item $Existing $Old
    $WasRunning = ((& $Existing status) -match 'status: RUNNING').Count -gt 0
    & $Existing stop | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to stop existing runtime' }
  }
  Copy-Item $Downloaded $Next
  if (Test-Path $Existing) { [IO.File]::Replace($Next, $Existing, $null) }
  else { Move-Item $Next $Existing }
  if ($WasRunning) {
    & $Existing start
    if ($LASTEXITCODE -ne 0) {
      & $Existing stop | Out-Null
      Copy-Item $Old $Next
      [IO.File]::Replace($Next, $Existing, $null)
      & $Existing start
      throw 'Replacement failed; previous binary restored'
    }
  }
  if (Test-Path $Old) {
    New-Item -ItemType Directory -Force -Path $Previous | Out-Null
    Copy-Item -Force $Old (Join-Path $Previous 'bot-report-worker.exe')
    $OldHash = (Get-FileHash -Algorithm SHA256 $Old).Hash.ToLowerInvariant()
    Set-Content -Encoding ascii -Path (Join-Path $Previous 'SHA256SUMS') -Value "$OldHash  $File"
  }

  New-Item -ItemType Directory -Force -Path $WorkerHome | Out-Null
  if (-not (Test-Path (Join-Path $WorkerHome 'default-server'))) { Set-Content -Encoding ascii -Path (Join-Path $WorkerHome 'default-server') -Value $BaseUrl }
  Set-Content -Encoding ascii -Path (Join-Path $WorkerHome 'install-root') -Value $InstallRoot
  Set-Content -Encoding ascii -Path (Join-Path $WorkerHome 'bin-path') -Value (Join-Path $Target 'bot-report-worker.exe')
  Set-Content -Encoding ascii -Path $VersionPath -Value $PinnedVersion
  Set-Content -Encoding ascii -Path $CommitPath -Value $PinnedCommit

  if ($env:BOT_REPORT_WORKER_SKIP_PATH -ne '1') {
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $PathItems = @($UserPath -split ';' | Where-Object { $_ })
    if (-not ($PathItems | Where-Object { [string]::Equals([IO.Path]::GetFullPath($_), [IO.Path]::GetFullPath($Target), [StringComparison]::OrdinalIgnoreCase) })) {
      $NewPath = (($PathItems + $Target) -join ';')
      [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    }
  }
  $env:Path = "$Target;$env:Path"
  Write-Host "[bot-report-worker] installed standalone runtime: $(Join-Path $Target 'bot-report-worker.exe') (windows/$Arch)"
  if (Test-Path (Join-Path $WorkerHome 'state.json')) {
    Write-Host '[bot-report-worker] existing identity preserved; next: bot-report-worker start'
  } else {
    Write-Host '[bot-report-worker] next: bot-report-worker login'
  }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
  if ($LockOwned) { Remove-Item -Force -ErrorAction SilentlyContinue $Lock }
}
`;
}

function normalizeProfileBase(value: unknown) {
  const clean = String(value || '')
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 90);
  return clean || 'Worker';
}

async function createEnrollmentProfile(
  worker: { id: string; name: string },
  { requestedName }: { requestedName?: string } = {},
) {
  const base = normalizeProfileBase(requestedName || worker.name);
  const suffix = worker.id.replace(/-/g, '').slice(0, 8);
  const candidates = [base, `${base}-${suffix}`];
  for (const name of candidates) {
    try {
      return await workerRepository.createProfile({
        name,
        description: `Auto-created during enrollment for ${worker.name}`,
        workerId: worker.id,
        enabled: true,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORKER_PROFILE_NAME_CONFLICT'
      )
        continue;
      throw error;
    }
  }
  throw Object.assign(new Error('Unable to allocate a unique Worker Profile alias.'), {
    code: 'WORKER_PROFILE_NAME_CONFLICT',
    status: 409,
  });
}

// CI builds are unsigned private artifacts. A fresh Railway clone must not
// advertise curl-to-shell execution until a pinned signing-key distribution
// and mandatory cross-platform verification have passed release review.
router.use((req, res, next) => {
  if (
    process.env.MCP_PLATFORM === 'railway' &&
    (req.path.startsWith('/worker/install') || req.path.startsWith('/worker/dist/'))
  ) {
    return res.status(503).set('Cache-Control', 'no-store').json({
      code: 'WORKER_SIGNED_RELEASE_PENDING',
      error: 'Verified Worker installer requires a signed and approved release.',
    });
  }
  return next();
});

router.get('/worker/install.sh', (req, res, next) => {
  try {
    return res
      .type('text/x-shellscript')
      .set('cache-control', 'no-store')
      .send(installerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});

router.get('/worker/install-linux.sh', (req, res, next) => {
  try {
    return res
      .type('text/x-shellscript')
      .set('cache-control', 'no-store')
      .send(installerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});
router.get('/worker/install-macos.sh', (req, res, next) => {
  try {
    return res
      .type('text/x-shellscript')
      .set('cache-control', 'no-store')
      .send(macInstallerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});
router.get('/worker/install.ps1', (req, res, next) => {
  try {
    return res
      .type('text/plain')
      .set('cache-control', 'no-store')
      .send(windowsInstallerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});
router.get('/worker/install-windows.ps1', (req, res, next) => {
  try {
    return res
      .type('text/plain')
      .set('cache-control', 'no-store')
      .send(windowsInstallerPayloadScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});

router.get('/worker/dist/WORKER_RELEASE', (req, res) => {
  const metadata = path.join(WORKER_BIN_DIR, 'WORKER_RELEASE');
  if (!fs.existsSync(metadata))
    return res.status(503).json({
      error: 'Worker release metadata is not available.',
      code: 'WORKER_RELEASE_UNAVAILABLE',
    });
  return res.type('text/plain').set('cache-control', 'no-store').sendFile(metadata);
});

router.get('/worker/dist/SHA256SUMS.sig', (req, res) => {
  const signature = path.join(WORKER_BIN_DIR, 'SHA256SUMS.sig');
  if (!fs.existsSync(signature))
    return res.status(503).json({
      error: 'Signed Worker manifest is not available.',
      code: 'WORKER_SIGNATURE_UNAVAILABLE',
    });
  return res.type('application/octet-stream').set('cache-control', 'no-store').sendFile(signature);
});

router.get('/worker/dist/SHA256SUMS', (req, res) => {
  const manifest = path.join(WORKER_BIN_DIR, 'SHA256SUMS');
  if (!fs.existsSync(manifest))
    return res.status(503).json({
      error: 'Worker binary distribution is not built.',
      code: 'WORKER_BINARY_DIST_UNAVAILABLE',
    });
  return res.type('text/plain').set('cache-control', 'no-store').sendFile(manifest);
});

router.get('/worker/dist/:file', (req, res) => {
  const file = String(req.params.file || '');
  if (!DIST_FILES.includes(file))
    return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });
  const directory = BINARY_DIST_FILES.includes(file) ? WORKER_BIN_DIR : WORKER_DIR;
  const target = path.join(directory, file);
  if (!fs.existsSync(target))
    return res.status(503).json({
      error: 'Worker binary distribution is not built.',
      code: 'WORKER_BINARY_DIST_UNAVAILABLE',
    });
  return res.set('cache-control', 'no-store').sendFile(target);
});

router.post('/worker/v1/enroll', enrollmentLimiter, async (req, res, next) => {
  try {
    if (!databaseManager.isSqlReady()) {
      return res.status(503).json({
        error: 'temporarily_unavailable',
        code: databaseManager.status().state,
        message: 'MySQL must be ready before workers can enroll.',
      });
    }
    const worker = await workerAuthService.enroll({
      token: req.body?.token,
      name: req.body?.name,
      publicKey: req.body?.public_key,
      capabilities: req.body?.capabilities,
    });
    if (!worker)
      throw Object.assign(new Error('Worker enrollment did not return an identity.'), {
        code: 'WORKER_ENROLLMENT_INVALID',
        status: 500,
      });
    const wantsProfile = req.body?.create_profile === true;
    const profile = wantsProfile
      ? await createEnrollmentProfile(worker, {
          requestedName: req.body?.profile_name,
        })
      : null;
    return res.status(201).json({
      worker_id: worker.id,
      name: worker.name,
      capabilities: worker.capabilities,
      connect_path: '/worker/v1/connect',
      profile: profile ? { id: profile.id, name: profile.name } : null,
    });
  } catch (error) {
    if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
      return res.status(error.status).json({
        error: 'worker_enrollment_failed',
        code: 'code' in error ? error.code : undefined,
        message: error.message,
      });
    }
    return next(error);
  }
});

export = Object.assign(router, {
  DIST_FILES,
  BINARY_DIST_FILES,
  LEGACY_DIST_FILES,
  installerScript,
  macInstallerScript,
  windowsInstallerScript,
  windowsInstallerPayloadScript,
  publicBaseUrl,
  createEnrollmentProfile,
});
 -or $PinnedCommit -cnotmatch '^[0-9a-f]{7,40} = if ($env:BOT_REPORT_WORKER_INSTALL_ROOT) { $env:BOT_REPORT_WORKER_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'BotReportWorker' }
$Target = Join-Path $InstallRoot 'current'
$Previous = Join-Path $InstallRoot 'previous'
$Action = if ($env:BOT_REPORT_WORKER_ACTION) { $env:BOT_REPORT_WORKER_ACTION } else { 'install' }
if ($Action -notin @('install','rollback')) { throw 'Invalid installer action' }
$WorkerHome = if ($env:BOT_REPORT_WORKER_HOME) { $env:BOT_REPORT_WORKER_HOME } else { Join-Path $HOME '.bot-report-worker' }
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('bot-report-worker-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Lock = Join-Path $InstallRoot '.install-lock'
$LockOwned = $false
try {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  foreach ($Path in @($InstallRoot, $Target, $Previous, $WorkerHome)) {
    if ((Test-Path $Path) -and ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse point installation refused' }
  }
  $RecordedRoot = Join-Path $WorkerHome 'install-root'
  $RecordedServer = Join-Path $WorkerHome 'default-server'
  if ((Test-Path $RecordedRoot) -and ((Get-Content $RecordedRoot -Raw).Trim() -ne $InstallRoot)) { throw 'Different existing installation root' }
  if ((Test-Path $RecordedServer) -and ((Get-Content $RecordedServer -Raw).Trim() -ne $BaseUrl)) { throw 'Different existing server' }
  New-Item -ItemType Directory -Path $Lock -ErrorAction Stop | Out-Null
  $LockOwned = $true
  $ArchRaw = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($ArchRaw) {
    'x64' { $Arch = 'amd64' }
    'arm64' { $Arch = 'arm64' }
    default { throw "Unsupported Windows architecture: $ArchRaw" }
  }
  $File = "bot-report-worker-windows-$Arch.exe"
  $Downloaded = Join-Path $Tmp 'bot-report-worker.exe'
  $Sums = Join-Path $Tmp 'SHA256SUMS'
  if ($Action -eq 'rollback') {
    Copy-Item (Join-Path $Previous 'bot-report-worker.exe') $Downloaded
    Copy-Item (Join-Path $Previous 'SHA256SUMS') $Sums
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/$File" -OutFile $Downloaded
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/SHA256SUMS" -OutFile $Sums
    if ($env:BOT_REPORT_WORKER_TRUSTED_KEY) {
      $Signature = Join-Path $Tmp 'SHA256SUMS.sig'
      Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/SHA256SUMS.sig" -OutFile $Signature
      & openssl dgst -sha256 -verify $env:BOT_REPORT_WORKER_TRUSTED_KEY -signature $Signature $Sums
      if ($LASTEXITCODE -ne 0) { throw 'Manifest signature verification failed' }
    }
  }
  $Expected = Get-Content $Sums | ForEach-Object { $parts = $_ -split '\\s+'; if ($parts.Count -ge 2 -and $parts[-1] -eq $File) { $parts[0] } } | Select-Object -First 1
  if (-not $Expected) { throw "Checksum manifest does not contain $File" }
  $Actual = (Get-FileHash -Algorithm SHA256 $Downloaded).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected.ToLowerInvariant()) { throw "Checksum verification failed for $File" }

  & $Downloaded version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Downloaded runtime failed version check' }
  $Existing = Join-Path $Target 'bot-report-worker.exe'
  $Old = Join-Path $Tmp 'old.exe'
  $Next = Join-Path $Target ('.next-' + [guid]::NewGuid().ToString('N') + '.exe')
  if ((Test-Path $Existing) -and ($Action -eq 'install') -and ((Get-FileHash -Algorithm SHA256 $Existing).Hash.ToLowerInvariant() -eq $Actual)) {
    Write-Host '[bot-report-worker] runtime already current; rollback retained'
    return
  }
  $WasRunning = $false
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  if (Test-Path $Existing) {
    Copy-Item $Existing $Old
    $WasRunning = ((& $Existing status) -match 'status: RUNNING').Count -gt 0
    & $Existing stop | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to stop existing runtime' }
  }
  Copy-Item $Downloaded $Next
  if (Test-Path $Existing) { [IO.File]::Replace($Next, $Existing, $null) }
  else { Move-Item $Next $Existing }
  if ($WasRunning) {
    & $Existing start
    if ($LASTEXITCODE -ne 0) {
      & $Existing stop | Out-Null
      Copy-Item $Old $Next
      [IO.File]::Replace($Next, $Existing, $null)
      & $Existing start
      throw 'Replacement failed; previous binary restored'
    }
  }
  if (Test-Path $Old) {
    New-Item -ItemType Directory -Force -Path $Previous | Out-Null
    Copy-Item -Force $Old (Join-Path $Previous 'bot-report-worker.exe')
    $OldHash = (Get-FileHash -Algorithm SHA256 $Old).Hash.ToLowerInvariant()
    Set-Content -Encoding ascii -Path (Join-Path $Previous 'SHA256SUMS') -Value "$OldHash  $File"
  }

  New-Item -ItemType Directory -Force -Path $WorkerHome | Out-Null
  if (-not (Test-Path (Join-Path $WorkerHome 'default-server'))) { Set-Content -Encoding ascii -Path (Join-Path $WorkerHome 'default-server') -Value $BaseUrl }
  Set-Content -Encoding ascii -Path (Join-Path $WorkerHome 'install-root') -Value $InstallRoot
  Set-Content -Encoding ascii -Path (Join-Path $WorkerHome 'bin-path') -Value (Join-Path $Target 'bot-report-worker.exe')

  if ($env:BOT_REPORT_WORKER_SKIP_PATH -ne '1') {
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $PathItems = @($UserPath -split ';' | Where-Object { $_ })
    if (-not ($PathItems | Where-Object { [string]::Equals([IO.Path]::GetFullPath($_), [IO.Path]::GetFullPath($Target), [StringComparison]::OrdinalIgnoreCase) })) {
      $NewPath = (($PathItems + $Target) -join ';')
      [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    }
  }
  $env:Path = "$Target;$env:Path"
  Write-Host "[bot-report-worker] installed standalone runtime: $(Join-Path $Target 'bot-report-worker.exe') (windows/$Arch)"
  if (Test-Path (Join-Path $WorkerHome 'state.json')) {
    Write-Host '[bot-report-worker] existing identity preserved; next: bot-report-worker start'
  } else {
    Write-Host '[bot-report-worker] next: bot-report-worker login'
  }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
  if ($LockOwned) { Remove-Item -Force -ErrorAction SilentlyContinue $Lock }
}
`;
}

function normalizeProfileBase(value: unknown) {
  const clean = String(value || '')
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 90);
  return clean || 'Worker';
}

async function createEnrollmentProfile(
  worker: { id: string; name: string },
  { requestedName }: { requestedName?: string } = {},
) {
  const base = normalizeProfileBase(requestedName || worker.name);
  const suffix = worker.id.replace(/-/g, '').slice(0, 8);
  const candidates = [base, `${base}-${suffix}`];
  for (const name of candidates) {
    try {
      return await workerRepository.createProfile({
        name,
        description: `Auto-created during enrollment for ${worker.name}`,
        workerId: worker.id,
        enabled: true,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORKER_PROFILE_NAME_CONFLICT'
      )
        continue;
      throw error;
    }
  }
  throw Object.assign(new Error('Unable to allocate a unique Worker Profile alias.'), {
    code: 'WORKER_PROFILE_NAME_CONFLICT',
    status: 409,
  });
}

// CI builds are unsigned private artifacts. A fresh Railway clone must not
// advertise curl-to-shell execution until a pinned signing-key distribution
// and mandatory cross-platform verification have passed release review.
router.use((req, res, next) => {
  if (
    process.env.MCP_PLATFORM === 'railway' &&
    (req.path.startsWith('/worker/install') || req.path.startsWith('/worker/dist/'))
  ) {
    return res.status(503).set('Cache-Control', 'no-store').json({
      code: 'WORKER_SIGNED_RELEASE_PENDING',
      error: 'Verified Worker installer requires a signed and approved release.',
    });
  }
  return next();
});

router.get('/worker/install.sh', (req, res, next) => {
  try {
    return res
      .type('text/x-shellscript')
      .set('cache-control', 'no-store')
      .send(installerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});

router.get('/worker/install-linux.sh', (req, res, next) => {
  try {
    return res
      .type('text/x-shellscript')
      .set('cache-control', 'no-store')
      .send(installerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});
router.get('/worker/install-macos.sh', (req, res, next) => {
  try {
    return res
      .type('text/x-shellscript')
      .set('cache-control', 'no-store')
      .send(macInstallerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});
router.get('/worker/install.ps1', (req, res, next) => {
  try {
    return res
      .type('text/plain')
      .set('cache-control', 'no-store')
      .send(windowsInstallerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});
router.get('/worker/install-windows.ps1', (req, res, next) => {
  try {
    return res
      .type('text/plain')
      .set('cache-control', 'no-store')
      .send(windowsInstallerPayloadScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});

router.get('/worker/dist/WORKER_RELEASE', (req, res) => {
  const metadata = path.join(WORKER_BIN_DIR, 'WORKER_RELEASE');
  if (!fs.existsSync(metadata))
    return res.status(503).json({
      error: 'Worker release metadata is not available.',
      code: 'WORKER_RELEASE_UNAVAILABLE',
    });
  return res.type('text/plain').set('cache-control', 'no-store').sendFile(metadata);
});

router.get('/worker/dist/SHA256SUMS.sig', (req, res) => {
  const signature = path.join(WORKER_BIN_DIR, 'SHA256SUMS.sig');
  if (!fs.existsSync(signature))
    return res.status(503).json({
      error: 'Signed Worker manifest is not available.',
      code: 'WORKER_SIGNATURE_UNAVAILABLE',
    });
  return res.type('application/octet-stream').set('cache-control', 'no-store').sendFile(signature);
});

router.get('/worker/dist/SHA256SUMS', (req, res) => {
  const manifest = path.join(WORKER_BIN_DIR, 'SHA256SUMS');
  if (!fs.existsSync(manifest))
    return res.status(503).json({
      error: 'Worker binary distribution is not built.',
      code: 'WORKER_BINARY_DIST_UNAVAILABLE',
    });
  return res.type('text/plain').set('cache-control', 'no-store').sendFile(manifest);
});

router.get('/worker/dist/:file', (req, res) => {
  const file = String(req.params.file || '');
  if (!DIST_FILES.includes(file))
    return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });
  const directory = BINARY_DIST_FILES.includes(file) ? WORKER_BIN_DIR : WORKER_DIR;
  const target = path.join(directory, file);
  if (!fs.existsSync(target))
    return res.status(503).json({
      error: 'Worker binary distribution is not built.',
      code: 'WORKER_BINARY_DIST_UNAVAILABLE',
    });
  return res.set('cache-control', 'no-store').sendFile(target);
});

router.post('/worker/v1/enroll', enrollmentLimiter, async (req, res, next) => {
  try {
    if (!databaseManager.isSqlReady()) {
      return res.status(503).json({
        error: 'temporarily_unavailable',
        code: databaseManager.status().state,
        message: 'MySQL must be ready before workers can enroll.',
      });
    }
    const worker = await workerAuthService.enroll({
      token: req.body?.token,
      name: req.body?.name,
      publicKey: req.body?.public_key,
      capabilities: req.body?.capabilities,
    });
    if (!worker)
      throw Object.assign(new Error('Worker enrollment did not return an identity.'), {
        code: 'WORKER_ENROLLMENT_INVALID',
        status: 500,
      });
    const wantsProfile = req.body?.create_profile === true;
    const profile = wantsProfile
      ? await createEnrollmentProfile(worker, {
          requestedName: req.body?.profile_name,
        })
      : null;
    return res.status(201).json({
      worker_id: worker.id,
      name: worker.name,
      capabilities: worker.capabilities,
      connect_path: '/worker/v1/connect',
      profile: profile ? { id: profile.id, name: profile.name } : null,
    });
  } catch (error) {
    if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
      return res.status(error.status).json({
        error: 'worker_enrollment_failed',
        code: 'code' in error ? error.code : undefined,
        message: error.message,
      });
    }
    return next(error);
  }
});

export = Object.assign(router, {
  DIST_FILES,
  BINARY_DIST_FILES,
  LEGACY_DIST_FILES,
  installerScript,
  macInstallerScript,
  windowsInstallerScript,
  windowsInstallerPayloadScript,
  publicBaseUrl,
  createEnrollmentProfile,
});
) { throw 'Invalid release pin' }
Get-Command openssl -ErrorAction Stop | Out-Null
$InstallRoot = if ($env:BOT_REPORT_WORKER_INSTALL_ROOT) { $env:BOT_REPORT_WORKER_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'BotReportWorker' }
$Target = Join-Path $InstallRoot 'current'
$Previous = Join-Path $InstallRoot 'previous'
$Action = if ($env:BOT_REPORT_WORKER_ACTION) { $env:BOT_REPORT_WORKER_ACTION } else { 'install' }
if ($Action -notin @('install','rollback')) { throw 'Invalid installer action' }
$WorkerHome = if ($env:BOT_REPORT_WORKER_HOME) { $env:BOT_REPORT_WORKER_HOME } else { Join-Path $HOME '.bot-report-worker' }
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('bot-report-worker-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$Lock = Join-Path $InstallRoot '.install-lock'
$LockOwned = $false
try {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  foreach ($Path in @($InstallRoot, $Target, $Previous, $WorkerHome)) {
    if ((Test-Path $Path) -and ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse point installation refused' }
  }
  $RecordedRoot = Join-Path $WorkerHome 'install-root'
  $RecordedServer = Join-Path $WorkerHome 'default-server'
  if ((Test-Path $RecordedRoot) -and ((Get-Content $RecordedRoot -Raw).Trim() -ne $InstallRoot)) { throw 'Different existing installation root' }
  if ((Test-Path $RecordedServer) -and ((Get-Content $RecordedServer -Raw).Trim() -ne $BaseUrl)) { throw 'Different existing server' }
  New-Item -ItemType Directory -Path $Lock -ErrorAction Stop | Out-Null
  $LockOwned = $true
  $ArchRaw = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($ArchRaw) {
    'x64' { $Arch = 'amd64' }
    'arm64' { $Arch = 'arm64' }
    default { throw "Unsupported Windows architecture: $ArchRaw" }
  }
  $File = "bot-report-worker-windows-$Arch.exe"
  $Downloaded = Join-Path $Tmp 'bot-report-worker.exe'
  $Sums = Join-Path $Tmp 'SHA256SUMS'
  if ($Action -eq 'rollback') {
    Copy-Item (Join-Path $Previous 'bot-report-worker.exe') $Downloaded
    Copy-Item (Join-Path $Previous 'SHA256SUMS') $Sums
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/$File" -OutFile $Downloaded
  Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/SHA256SUMS" -OutFile $Sums
    if ($env:BOT_REPORT_WORKER_TRUSTED_KEY) {
      $Signature = Join-Path $Tmp 'SHA256SUMS.sig'
      Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/worker/dist/SHA256SUMS.sig" -OutFile $Signature
      & openssl dgst -sha256 -verify $env:BOT_REPORT_WORKER_TRUSTED_KEY -signature $Signature $Sums
      if ($LASTEXITCODE -ne 0) { throw 'Manifest signature verification failed' }
    }
  }
  $Expected = Get-Content $Sums | ForEach-Object { $parts = $_ -split '\\s+'; if ($parts.Count -ge 2 -and $parts[-1] -eq $File) { $parts[0] } } | Select-Object -First 1
  if (-not $Expected) { throw "Checksum manifest does not contain $File" }
  $Actual = (Get-FileHash -Algorithm SHA256 $Downloaded).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected.ToLowerInvariant()) { throw "Checksum verification failed for $File" }

  & $Downloaded version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Downloaded runtime failed version check' }
  $Existing = Join-Path $Target 'bot-report-worker.exe'
  $Old = Join-Path $Tmp 'old.exe'
  $Next = Join-Path $Target ('.next-' + [guid]::NewGuid().ToString('N') + '.exe')
  if ((Test-Path $Existing) -and ($Action -eq 'install') -and ((Get-FileHash -Algorithm SHA256 $Existing).Hash.ToLowerInvariant() -eq $Actual)) {
    Write-Host '[bot-report-worker] runtime already current; rollback retained'
    return
  }
  $WasRunning = $false
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  if (Test-Path $Existing) {
    Copy-Item $Existing $Old
    $WasRunning = ((& $Existing status) -match 'status: RUNNING').Count -gt 0
    & $Existing stop | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to stop existing runtime' }
  }
  Copy-Item $Downloaded $Next
  if (Test-Path $Existing) { [IO.File]::Replace($Next, $Existing, $null) }
  else { Move-Item $Next $Existing }
  if ($WasRunning) {
    & $Existing start
    if ($LASTEXITCODE -ne 0) {
      & $Existing stop | Out-Null
      Copy-Item $Old $Next
      [IO.File]::Replace($Next, $Existing, $null)
      & $Existing start
      throw 'Replacement failed; previous binary restored'
    }
  }
  if (Test-Path $Old) {
    New-Item -ItemType Directory -Force -Path $Previous | Out-Null
    Copy-Item -Force $Old (Join-Path $Previous 'bot-report-worker.exe')
    $OldHash = (Get-FileHash -Algorithm SHA256 $Old).Hash.ToLowerInvariant()
    Set-Content -Encoding ascii -Path (Join-Path $Previous 'SHA256SUMS') -Value "$OldHash  $File"
  }

  New-Item -ItemType Directory -Force -Path $WorkerHome | Out-Null
  if (-not (Test-Path (Join-Path $WorkerHome 'default-server'))) { Set-Content -Encoding ascii -Path (Join-Path $WorkerHome 'default-server') -Value $BaseUrl }
  Set-Content -Encoding ascii -Path (Join-Path $WorkerHome 'install-root') -Value $InstallRoot
  Set-Content -Encoding ascii -Path (Join-Path $WorkerHome 'bin-path') -Value (Join-Path $Target 'bot-report-worker.exe')

  if ($env:BOT_REPORT_WORKER_SKIP_PATH -ne '1') {
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $PathItems = @($UserPath -split ';' | Where-Object { $_ })
    if (-not ($PathItems | Where-Object { [string]::Equals([IO.Path]::GetFullPath($_), [IO.Path]::GetFullPath($Target), [StringComparison]::OrdinalIgnoreCase) })) {
      $NewPath = (($PathItems + $Target) -join ';')
      [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    }
  }
  $env:Path = "$Target;$env:Path"
  Write-Host "[bot-report-worker] installed standalone runtime: $(Join-Path $Target 'bot-report-worker.exe') (windows/$Arch)"
  if (Test-Path (Join-Path $WorkerHome 'state.json')) {
    Write-Host '[bot-report-worker] existing identity preserved; next: bot-report-worker start'
  } else {
    Write-Host '[bot-report-worker] next: bot-report-worker login'
  }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
  if ($LockOwned) { Remove-Item -Force -ErrorAction SilentlyContinue $Lock }
}
`;
}

function normalizeProfileBase(value: unknown) {
  const clean = String(value || '')
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, 90);
  return clean || 'Worker';
}

async function createEnrollmentProfile(
  worker: { id: string; name: string },
  { requestedName }: { requestedName?: string } = {},
) {
  const base = normalizeProfileBase(requestedName || worker.name);
  const suffix = worker.id.replace(/-/g, '').slice(0, 8);
  const candidates = [base, `${base}-${suffix}`];
  for (const name of candidates) {
    try {
      return await workerRepository.createProfile({
        name,
        description: `Auto-created during enrollment for ${worker.name}`,
        workerId: worker.id,
        enabled: true,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORKER_PROFILE_NAME_CONFLICT'
      )
        continue;
      throw error;
    }
  }
  throw Object.assign(new Error('Unable to allocate a unique Worker Profile alias.'), {
    code: 'WORKER_PROFILE_NAME_CONFLICT',
    status: 409,
  });
}

// CI builds are unsigned private artifacts. A fresh Railway clone must not
// advertise curl-to-shell execution until a pinned signing-key distribution
// and mandatory cross-platform verification have passed release review.
router.use((req, res, next) => {
  if (
    process.env.MCP_PLATFORM === 'railway' &&
    (req.path.startsWith('/worker/install') || req.path.startsWith('/worker/dist/'))
  ) {
    return res.status(503).set('Cache-Control', 'no-store').json({
      code: 'WORKER_SIGNED_RELEASE_PENDING',
      error: 'Verified Worker installer requires a signed and approved release.',
    });
  }
  return next();
});

router.get('/worker/install.sh', (req, res, next) => {
  try {
    return res
      .type('text/x-shellscript')
      .set('cache-control', 'no-store')
      .send(installerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});

router.get('/worker/install-linux.sh', (req, res, next) => {
  try {
    return res
      .type('text/x-shellscript')
      .set('cache-control', 'no-store')
      .send(installerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});
router.get('/worker/install-macos.sh', (req, res, next) => {
  try {
    return res
      .type('text/x-shellscript')
      .set('cache-control', 'no-store')
      .send(macInstallerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});
router.get('/worker/install.ps1', (req, res, next) => {
  try {
    return res
      .type('text/plain')
      .set('cache-control', 'no-store')
      .send(windowsInstallerScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});
router.get('/worker/install-windows.ps1', (req, res, next) => {
  try {
    return res
      .type('text/plain')
      .set('cache-control', 'no-store')
      .send(windowsInstallerPayloadScript(publicBaseUrl(req)));
  } catch (error) {
    return next(error);
  }
});

router.get('/worker/dist/WORKER_RELEASE', (req, res) => {
  const metadata = path.join(WORKER_BIN_DIR, 'WORKER_RELEASE');
  if (!fs.existsSync(metadata))
    return res.status(503).json({
      error: 'Worker release metadata is not available.',
      code: 'WORKER_RELEASE_UNAVAILABLE',
    });
  return res.type('text/plain').set('cache-control', 'no-store').sendFile(metadata);
});

router.get('/worker/dist/SHA256SUMS.sig', (req, res) => {
  const signature = path.join(WORKER_BIN_DIR, 'SHA256SUMS.sig');
  if (!fs.existsSync(signature))
    return res.status(503).json({
      error: 'Signed Worker manifest is not available.',
      code: 'WORKER_SIGNATURE_UNAVAILABLE',
    });
  return res.type('application/octet-stream').set('cache-control', 'no-store').sendFile(signature);
});

router.get('/worker/dist/SHA256SUMS', (req, res) => {
  const manifest = path.join(WORKER_BIN_DIR, 'SHA256SUMS');
  if (!fs.existsSync(manifest))
    return res.status(503).json({
      error: 'Worker binary distribution is not built.',
      code: 'WORKER_BINARY_DIST_UNAVAILABLE',
    });
  return res.type('text/plain').set('cache-control', 'no-store').sendFile(manifest);
});

router.get('/worker/dist/:file', (req, res) => {
  const file = String(req.params.file || '');
  if (!DIST_FILES.includes(file))
    return res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });
  const directory = BINARY_DIST_FILES.includes(file) ? WORKER_BIN_DIR : WORKER_DIR;
  const target = path.join(directory, file);
  if (!fs.existsSync(target))
    return res.status(503).json({
      error: 'Worker binary distribution is not built.',
      code: 'WORKER_BINARY_DIST_UNAVAILABLE',
    });
  return res.set('cache-control', 'no-store').sendFile(target);
});

router.post('/worker/v1/enroll', enrollmentLimiter, async (req, res, next) => {
  try {
    if (!databaseManager.isSqlReady()) {
      return res.status(503).json({
        error: 'temporarily_unavailable',
        code: databaseManager.status().state,
        message: 'MySQL must be ready before workers can enroll.',
      });
    }
    const worker = await workerAuthService.enroll({
      token: req.body?.token,
      name: req.body?.name,
      publicKey: req.body?.public_key,
      capabilities: req.body?.capabilities,
    });
    if (!worker)
      throw Object.assign(new Error('Worker enrollment did not return an identity.'), {
        code: 'WORKER_ENROLLMENT_INVALID',
        status: 500,
      });
    const wantsProfile = req.body?.create_profile === true;
    const profile = wantsProfile
      ? await createEnrollmentProfile(worker, {
          requestedName: req.body?.profile_name,
        })
      : null;
    return res.status(201).json({
      worker_id: worker.id,
      name: worker.name,
      capabilities: worker.capabilities,
      connect_path: '/worker/v1/connect',
      profile: profile ? { id: profile.id, name: profile.name } : null,
    });
  } catch (error) {
    if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
      return res.status(error.status).json({
        error: 'worker_enrollment_failed',
        code: 'code' in error ? error.code : undefined,
        message: error.message,
      });
    }
    return next(error);
  }
});

export = Object.assign(router, {
  DIST_FILES,
  BINARY_DIST_FILES,
  LEGACY_DIST_FILES,
  installerScript,
  macInstallerScript,
  windowsInstallerScript,
  windowsInstallerPayloadScript,
  publicBaseUrl,
  createEnrollmentProfile,
});
