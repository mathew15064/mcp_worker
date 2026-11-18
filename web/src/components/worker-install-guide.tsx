import { Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const release = 'https://github.com/mathew15064/mcp_worker/releases';
const signedV2 = release + '/tag/v2.0.0';
const download = release + '/download/v2.0.0';

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

function instructions(os: 'linux' | 'macos' | 'windows', serverUrl: string) {
  // Quote the server-configured URL before inserting it into an executable command.
  const shellUrl = "'" + serverUrl.replace(/'/g, "'\\''") + "'";
  const powershellUrl = "'" + serverUrl.replace(/'/g, "''") + "'";
  if (os === 'linux') return [
    'curl -fsSLo install-linux.sh ' + download + '/install-linux.sh',
    '# Review install-linux.sh before executing the signed release installer.',
    'sh install-linux.sh',
    '~/.local/bin/mcp_worker setup --server ' + shellUrl,
    '~/.local/bin/mcp_worker status',
  ].join('\n');
  if (os === 'macos') return [
    'curl -fsSLo install-macos.sh ' + download + '/install-macos.sh',
    '# Review install-macos.sh before executing the signed release installer.',
    'sh install-macos.sh',
    '~/.local/bin/mcp_worker setup --server ' + shellUrl,
    '~/.local/bin/mcp_worker status',
  ].join('\n');
  return [
    'Invoke-WebRequest ' + download + '/install-windows.ps1 -OutFile install-windows.ps1',
    '# Review install-windows.ps1 before running it in PowerShell.',
    '.\\install-windows.ps1',
    'mcp_worker setup --server ' + powershellUrl,
    'mcp_worker status',
  ].join('\n');
}

export function WorkerInstallGuide({ mcpEndpoint }: { mcpEndpoint: string }) {
  const serverUrl = serverBaseUrl(mcpEndpoint);
  return (
    <div className="min-w-0 space-y-3" data-worker-install-guide>
      <div className="space-y-1">
        <p className="text-sm font-semibold">Install Worker · signed v2.0.0</p>
        <p className="text-xs text-muted-foreground">
          Select the target OS, copy the commands, review the downloaded installer, then enter
          your one-time enrollment token only when prompted. The token is never included in commands.
        </p>
      </div>
      {serverUrl ? (
        <Tabs defaultValue="linux">
          <TabsList aria-label="Worker operating system">
            <TabsTrigger value="linux">Linux</TabsTrigger>
            <TabsTrigger value="macos">macOS</TabsTrigger>
            <TabsTrigger value="windows">Windows</TabsTrigger>
          </TabsList>
          {(['linux', 'macos', 'windows'] as const).map((os) => {
            const commands = instructions(os, serverUrl);
            return (
              <TabsContent key={os} value={os} className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {os === 'windows' ? 'PowerShell · requires OpenSSL' : 'Terminal · requires curl and OpenSSL'}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard.writeText(commands)
                        .then(() => toast.success('Install commands copied'))
                        .catch(() => toast.error('Copy failed'));
                    }}
                  >
                    <Copy className="size-3.5" />
                    Copy commands
                  </Button>
                </div>
                <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-secondary/40 p-3 text-xs leading-relaxed">
                  {commands}
                </pre>
              </TabsContent>
            );
          })}
        </Tabs>
      ) : (
        <p role="status" className="text-xs text-destructive">MCP server URL is unavailable.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Server-hosted installers remain disabled (HTTP 503). Use the{' '}
        <a href={signedV2} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
          official signed GitHub release <ExternalLink className="size-3" />
        </a>. Enrollment requires an Admin-generated one-time token; installation alone does
        not enable hosted execution.
      </p>
    </div>
  );
}
