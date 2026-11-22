import { ChevronDown, Copy, ExternalLink, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const release = 'https://github.com/mathew15064/mcp_worker/releases';
const signedV2 = release + '/tag/v2.0.0';
const download = release + '/download/v2.0.0';

type WorkerOS = 'linux' | 'macos' | 'windows';

interface CommandStep {
  title: string;
  description: string;
  command: string;
}

function serverBaseUrl(mcpEndpoint: string) {
  try {
    const url = new URL(mcpEndpoint);
    if (!['https:', 'http:'].includes(url.protocol) || !url.pathname.endsWith('/mcp'))
      return '';
    return url.origin + url.pathname.slice(0, -4).replace(/\/$/, '');
  } catch {
    return '';
  }
}

function loginCommand(os: WorkerOS, serverUrl: string) {
  const command = 'mcp_worker';
  // Quote the server-configured URL for the target OS. Never include the enrollment token.
  const quotedUrl = os === 'windows'
    ? "'" + serverUrl.replace(/'/g, "''") + "'"
    : "'" + serverUrl.replace(/'/g, "'\\''") + "'";
  return command + ' login --server ' + quotedUrl;
}

function shellProfile(os: WorkerOS) {
  return os === 'macos'
    ? 'case "${SHELL##*/}" in zsh) rc_file="$HOME/.zshrc" ;; *) rc_file="$HOME/.bashrc" ;; esac'
    : 'rc_file="$HOME/.bashrc"';
}

function shellPathCommand(os: WorkerOS) {
  return [
    'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac',
    shellProfile(os),
    'path_line=\'export PATH="$HOME/.local/bin:$PATH"\'',
    'if [ -L "$rc_file" ]; then',
    '  printf "Refusing to edit a symlinked shell profile: %s\\n" "$rc_file" >&2; false',
    'elif ! grep -Fqx "$path_line" "$rc_file" 2>/dev/null; then',
    '  printf \'\\n%s\\n\' "$path_line" >> "$rc_file"',
    'fi',
    'hash -r',
  ].join('\n');
}

function quickInstallCommand(os: WorkerOS) {
  if (os === 'windows') {
    return [
      "$ErrorActionPreference = 'Stop'",
      "$workerTmp = Join-Path ([IO.Path]::GetTempPath()) ('mcp-worker-install-' + [guid]::NewGuid().ToString('N'))",
      'New-Item -ItemType Directory -Path $workerTmp | Out-Null',
      'try {',
      "  $installer = Join-Path $workerTmp 'install-windows.ps1'",
      "  Invoke-WebRequest -Uri '" + download + "/install-windows.ps1' -OutFile $installer",
      "  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Installer download failed' }",
      '  & $installer',
      "} finally { Remove-Item -LiteralPath $workerTmp -Recurse -Force -ErrorAction SilentlyContinue }",
      "$workerBin = Join-Path $env:LOCALAPPDATA 'BotReportWorker\\current'",
      "$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')",
      "if (-not (@($userPath -split ';') | Where-Object { $_ -ieq $workerBin })) {",
      "  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $workerBin).TrimStart(';')), 'User')",
      '}',
      `if (-not (@($env:Path -split ';') | Where-Object { $_ -ieq $workerBin })) { $env:Path = "$workerBin;$env:Path" }`,
      "& (Join-Path $workerBin 'worker_mcp.exe') version",
    ].join('\n');
  }

  const script = os === 'macos' ? 'install-macos.sh' : 'install-linux.sh';
  return [
    'worker_tmp="$(mktemp -d /tmp/mcp-worker-install.XXXXXX)" && (',
    '  trap \'rm -rf -- "$worker_tmp"\' EXIT',
    '  cd "$worker_tmp" &&',
    "  curl --proto '=https' --proto-redir '=https' -fsSLo " + script + ' ' + download + '/' + script + ' &&',
    '  test -s ' + script + ' &&',
    os === 'linux' ? '  MCP_WORKER_WORKER_SYSTEMD=1 sh ' + script : '  sh ' + script,
    ') && {',
    ...shellPathCommand(os).split('\n').map((line) => '  ' + line)
      .map((line) => line === '  fi' ? '  fi &&' : line === '  hash -r' ? '  hash -r &&' : line),
    '  mcp_worker version',
    '}',
  ].join('\n');
}

function installSteps(os: WorkerOS, serverUrl: string): CommandStep[] {
  const script = os === 'linux' ? 'install-linux.sh'
    : os === 'macos' ? 'install-macos.sh' : 'install-windows.ps1';
  const windows = os === 'windows';
  const temp = windows ? '$workerTmp' : '$worker_tmp';
  const downloadCommand = windows
    ? "$workerTmp = Join-Path ([IO.Path]::GetTempPath()) ('mcp-worker-install-' + [guid]::NewGuid().ToString('N'))\nNew-Item -ItemType Directory -Path $workerTmp | Out-Null\nInvoke-WebRequest -Uri '" + download + '/' + script + "' -OutFile (Join-Path $workerTmp '" + script + "')"
    : 'worker_tmp="$(mktemp -d /tmp/mcp-worker-install.XXXXXX)" && curl --proto \'=https\' --proto-redir \'=https\' -fsSLo "$worker_tmp/' + script + '" ' + download + '/' + script;
  return [
    {
      title: 'Download the installer',
      description: 'Download the official signed GitHub release to an isolated temporary directory.',
      command: downloadCommand,
    },
    {
      title: 'Review the script',
      description: 'Inspect the downloaded installer before running it on your machine.',
      command: windows ? "Get-Content (Join-Path " + temp + " '" + script + "')"
        : 'cat "$worker_tmp/' + script + '"',
    },
    {
      title: 'Install the Worker',
      description: os === 'linux'
        ? 'Install the verified Linux Worker as a systemd service (requires root or passwordless sudo); clean temporary files afterward.'
        : 'Run the reviewed installer and remove the temporary script afterward.',
      command: windows
        ? "& (Join-Path $workerTmp '" + script + "')\nRemove-Item -LiteralPath $workerTmp -Recurse -Force"
        : (os === 'linux' ? 'MCP_WORKER_WORKER_SYSTEMD=1 sh ' : 'sh ') + '"$worker_tmp/' + script + '" && rm -rf -- "$worker_tmp"',
    },
    {
      title: 'Make the CLI available',
      description: windows
        ? 'Refresh the current PowerShell PATH. The installer also configures your user PATH.'
        : 'Export PATH now and save it once to your shell profile for future sessions.',
      command: windows
        ? "$env:Path = (Join-Path $env:LOCALAPPDATA 'BotReportWorker\\current') + ';' + $env:Path"
        : shellPathCommand(os),
    },
    {
      title: 'Log in and enroll',
      description: 'Paste your one-time token at the hidden prompt. Never put the token in a command.',
      command: loginCommand(os, serverUrl),
    },
    {
      title: 'Check connection',
      description: 'Check local status, then confirm the Worker is Online in this dashboard.',
      command: os === 'linux' ? 'mcp_worker status && systemctl status worker_mcp.service --no-pager' : 'mcp_worker status',
    },
  ];
}

function CommandCopy({
  command,
  label = 'Copy command',
}: {
  command: string;
  label?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
      <pre className="max-h-64 min-w-0 max-w-full flex-1 overflow-auto whitespace-pre rounded-lg border border-border bg-secondary/40 px-3 py-2.5 font-mono text-xs leading-relaxed">
        <code>{command}</code>
      </pre>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-end sm:self-start"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard.writeText(command)
            .then(() => toast.success('Command copied'))
            .catch(() => toast.error('Copy failed'));
        }}
      >
        <Copy className="size-3.5" />
        Copy
      </Button>
    </div>
  );
}

function OperatingSystemTabs({
  mcpEndpoint,
  loginOnly = false,
}: {
  mcpEndpoint: string;
  loginOnly?: boolean;
}) {
  const serverUrl = serverBaseUrl(mcpEndpoint);
  if (!serverUrl)
    return <p role="status" className="text-xs text-destructive">MCP server URL is unavailable.</p>;

  return (
    <Tabs defaultValue="linux" className="min-w-0">
      <TabsList aria-label="Worker operating system">
        <TabsTrigger value="linux">Linux</TabsTrigger>
        <TabsTrigger value="macos">macOS</TabsTrigger>
        <TabsTrigger value="windows">Windows</TabsTrigger>
      </TabsList>
      {(['linux', 'macos', 'windows'] as const).map((os) => (
        <TabsContent key={os} value={os} className="min-w-0 pt-3">
          {loginOnly ? (
            <div className="min-w-0 space-y-2" data-worker-login-command>
              <p className="text-xs text-muted-foreground">
                Run on the machine with the Worker installed. Paste the copied token when the CLI
                asks for it; input is hidden.
              </p>
              <CommandCopy command={loginCommand(os, serverUrl)} />
            </div>
          ) : (
            <div className="min-w-0 space-y-4">
              <p className="text-xs text-muted-foreground">
                {os === 'windows'
                  ? 'PowerShell · OpenSSL required'
                  : 'Terminal · curl and OpenSSL required'}
              </p>
              <section className="min-w-0 space-y-3 rounded-xl border border-border/80 bg-secondary/15 p-3 sm:p-4" data-worker-quick-install>
                <div className="flex items-center gap-2">
                  <Terminal className="size-4 shrink-0 text-muted-foreground" />
                  <p className="text-sm font-semibold">Quick Install — one copy</p>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {os === 'windows'
                    ? 'Download and execute the reviewed installer in a temporary PowerShell directory, then refresh PATH.'
                    : os === 'linux'
                      ? 'Install the signed-release Linux Worker as a boot-enabled systemd service (root or passwordless sudo required). Download in /tmp, clean up and persist PATH. Do not install on an untrusted VPS.'
                      : 'Download and run the signed-release installer in /tmp, clean temporary files, and configure PATH for this shell and future sessions.'}
                  {' '}Your Worker binary and identity stay in persistent user directories, never in /tmp.
                </p>
                <CommandCopy command={quickInstallCommand(os)} label="Copy Quick Install" />
              </section>
              <details className="min-w-0 rounded-xl border border-border/70" data-worker-advanced>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-3 text-sm font-medium sm:px-4">
                  Advanced — download, review and install step by step
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </summary>
                <ol className="space-y-3 border-t border-border/70 p-3 sm:p-4" data-worker-install-steps>
                  {installSteps(os, serverUrl).map((step, index) => (
                    <li key={step.title} className="min-w-0 rounded-lg border border-border/70 p-3 sm:p-4">
                      <div className="mb-3 flex items-start gap-2.5">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
                          {index + 1}
                        </span>
                        <div className="min-w-0 space-y-1">
                          <p className="text-sm font-semibold">{step.title}</p>
                          <p className="text-xs leading-relaxed text-muted-foreground">{step.description}</p>
                        </div>
                      </div>
                      <CommandCopy command={step.command} />
                    </li>
                  ))}
                </ol>
              </details>
              <div className="min-w-0 space-y-3 rounded-xl border border-border/70 p-3 sm:p-4" data-worker-connect>
                <p className="text-sm font-semibold">Connect Worker</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  After installation, get a one-time token above. Run the login command, enter the token
                  at the hidden prompt and check the Worker status. Tokens are never part of copied commands.
                </p>
                <p className="text-xs font-medium">Log in and enroll</p>
                <CommandCopy command={loginCommand(os, serverUrl)} />
                <p className="text-xs font-medium">Check connection</p>
                <CommandCopy command={os === 'linux' ? 'mcp_worker status && systemctl status worker_mcp.service --no-pager' : 'mcp_worker status'} />
              </div>
            </div>
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function WorkerInstallGuide({ mcpEndpoint }: { mcpEndpoint: string }) {
  return (
    <div className="min-w-0 space-y-4" data-worker-install-guide>
      <p className="text-xs text-muted-foreground">
        Copy Quick Install once, or expand Advanced to review each step.
        Enter the one-time token interactively when enrolling, never in a command.
      </p>
      <OperatingSystemTabs mcpEndpoint={mcpEndpoint} />
      <p className="text-xs text-muted-foreground">
        Server-hosted installers remain disabled (HTTP 503). Use the{' '}
        <a
          href={signedV2}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
        >
          official signed GitHub release <ExternalLink className="size-3" />
        </a>. Installation does not authorize hosted execution.
      </p>
    </div>
  );
}

export function WorkerLoginGuide({ mcpEndpoint }: { mcpEndpoint: string }) {
  return (
    <div className="min-w-0 space-y-2" data-worker-login-guide>
      <p className="text-sm font-semibold">Log in to enroll this Worker</p>
      <OperatingSystemTabs mcpEndpoint={mcpEndpoint} loginOnly />
    </div>
  );
}
