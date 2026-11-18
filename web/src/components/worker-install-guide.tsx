import { Copy, ExternalLink } from 'lucide-react';
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
  const command = os === 'windows' ? 'mcp_worker' : '~/.local/bin/mcp_worker';
  // Quote the server-configured URL for the target OS. Never include the enrollment token.
  const quotedUrl = os === 'windows'
    ? "'" + serverUrl.replace(/'/g, "''") + "'"
    : "'" + serverUrl.replace(/'/g, "'\\''") + "'";
  return command + ' login --server ' + quotedUrl;
}

function installSteps(os: WorkerOS, serverUrl: string): CommandStep[] {
  const script = os === 'linux' ? 'install-linux.sh'
    : os === 'macos' ? 'install-macos.sh' : 'install-windows.ps1';
  const windows = os === 'windows';
  return [
    {
      title: 'Download the installer',
      description: 'Download the official v2.0.0 installer from the signed GitHub release, not from this MCP server.',
      command: windows
        ? 'Invoke-WebRequest ' + download + '/' + script + ' -OutFile ' + script
        : 'curl -fsSLo ' + script + ' ' + download + '/' + script,
    },
    {
      title: 'Review the script',
      description: 'Inspect the downloaded installer before running it on your machine.',
      command: windows ? 'Get-Content .\\' + script : 'cat ' + script,
    },
    {
      title: 'Install the Worker',
      description: 'Run the reviewed installer. It verifies the signed release and installs the standalone Worker.',
      command: windows ? '.\\' + script : 'sh ' + script,
    },
    {
      title: 'Log in and enroll',
      description: 'Run this command, then paste the one-time enrollment token at the hidden prompt. Never put the token in the command.',
      command: loginCommand(os, serverUrl),
    },
    {
      title: 'Check connection',
      description: 'Inspect the installed Worker status after login and confirm that it appears online in this dashboard.',
      command: windows ? 'mcp_worker status' : '~/.local/bin/mcp_worker status',
    },
  ];
}

function CommandCopy({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
      <pre className="min-w-0 max-w-full flex-1 overflow-x-auto whitespace-pre rounded-lg border border-border bg-secondary/40 px-3 py-2.5 font-mono text-xs leading-relaxed">
        <code>{command}</code>
      </pre>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-end sm:self-start"
        aria-label="Copy command"
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
              <ol className="space-y-3" data-worker-install-steps>
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
        Follow each step in order and copy only the command you need. The one-time token is
        entered interactively at login, never embedded in these commands.
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
