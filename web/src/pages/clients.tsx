import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Plus, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/app-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ConfirmAction,
  EmptyState,
  Field,
  FormDialog,
  PageHeading,
  SecretDialog,
  SecurityNote,
  Section,
  StatusBadge,
} from '@/components/common';

export function ClientsPage({ personal = false }: { personal?: boolean }) {
  const { state } = useApp();
  const [filter, setFilter] = useState('');
  const base = personal ? '/account' : '/admin';
  const clients = state?.data.clients || [];
  const visible = clients.filter((client) =>
    [
      client.display_name,
      client.client_id,
      client.principal_id,
      client.status,
      ...client.allowed_scopes,
      ...client.redirect_uris,
    ]
      .join(' ')
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  return (
    <div>
      <PageHeading
        title={personal ? 'My OAuth Clients' : 'OAuth Clients'}
        description={
          personal
            ? 'Create and manage OAuth clients owned by your account.'
            : 'Manage applications authorized to connect to the MCP gateway.'
        }
        action={
          <FormDialog
            title="New OAuth Client"
            description="Create a scoped OAuth client. The secret will be shown only once."
            action={base + '/clients'}
            trigger={
              <Button>
                <Plus className="size-4" />
                New Client
              </Button>
            }
            submitLabel="Create client"
          >
            <Field label="Display name">
              <Input name="display_name" defaultValue="ChatGPT" required maxLength={100} />
            </Field>
            <Field
              label="Redirect URI(s)"
              description="One HTTPS URI per line. Localhost callback URLs are allowed for local clients."
            >
              <Textarea
                name="redirect_uris"
                aria-label="Redirect URI(s)"
                rows={3}
                defaultValue="https://chatgpt.com/connector_platform_oauth_redirect"
                required
              />
            </Field>
            <div className="space-y-2">
              <Label>OAuth scopes</Label>
              <label className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
                <Checkbox name="scopes" value="mcp_worker.read" defaultChecked />
                <span>
                  <strong>Read access</strong>
                  <span className="block text-xs text-muted-foreground">
                    Required to discover MCP runtime capabilities.
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
                <Checkbox name="scopes" value="mcp_worker.terminal" />
                <span>
                  <strong>Terminal execution</strong>
                  <span className="block text-xs text-muted-foreground">
                    Only enable for a trusted client and an isolated, approved Worker.
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
                <Checkbox name="scopes" value="offline_access" />
                <span>
                  <strong>Offline access</strong>
                  <span className="block text-xs text-muted-foreground">
                    Allow refresh tokens for long-lived access.
                  </span>
                </span>
              </label>
            </div>
          </FormDialog>
        }
      />
      {personal && (
        <Section
          title="Identity isolation"
          description="Clients are always bound to your account."
          className="mb-5"
        >
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Principal ID</p>
              <code className="break-all text-xs">{state?.identity?.principal_id}</code>
            </div>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Execution profile</p>
              <code className="break-all text-xs">{state?.identity?.profile_id}</code>
            </div>
          </div>
        </Section>
      )}
      <Section
        title={'Client registry (' + clients.length + ')'}
        description="Credentials and scopes stay under server-side permission checks."
        action={
          <div className="relative">
            <Search className="absolute start-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search clients"
              placeholder="Search clients..."
              className="w-44 ps-9 sm:w-56"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        }
      >
        {visible.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  {!personal && <TableHead>Principal</TableHead>}
                  <TableHead>Status</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Last authorized</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell>
                      <p className="font-medium">{client.display_name}</p>
                      <button
                        className="mt-1 flex items-center gap-1 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(client.client_id)
                            .then(() => toast.success('Client ID copied'));
                        }}
                      >
                        <Copy className="size-3" /> {client.client_id.slice(0, 30)}…
                      </button>
                    </TableCell>
                    {!personal && (
                      <TableCell className="max-w-48 break-all font-mono text-[11px]">
                        {client.principal_id}
                      </TableCell>
                    )}
                    <TableCell>
                      <StatusBadge status={client.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-52 flex-wrap gap-1">
                        {client.allowed_scopes.map((scope) => (
                          <Badge key={scope} variant="outline" className="font-mono text-[10px]">
                            {scope.replace('mcp_worker.', '')}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {client.last_authorized_at
                        ? new Date(client.last_authorized_at).toLocaleString()
                        : 'Never'}
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-56 flex-wrap justify-end gap-1">
                        {!personal && (
                          <Button asChild variant="ghost" size="sm">
                            <Link
                              to={'/admin/audit?client_id=' + encodeURIComponent(client.client_id)}
                            >
                              Activity
                            </Link>
                          </Button>
                        )}
                        <ConfirmAction
                          action={base + '/clients/' + encodeURIComponent(client.id) + '/rotate'}
                          label="Rotate"
                          title="Rotate client secret?"
                          description="The old secret immediately stops working."
                        />
                        <ConfirmAction
                          action={
                            base +
                            '/clients/' +
                            encodeURIComponent(client.id) +
                            '/' +
                            (client.status === 'active' ? 'disable' : 'enable')
                          }
                          label={client.status === 'active' ? 'Disable' : 'Enable'}
                        />
                        <ConfirmAction
                          action={base + '/clients/' + encodeURIComponent(client.id) + '/revoke'}
                          label="Revoke"
                          destructive
                          description="All tokens issued to this client become invalid."
                        />
                        <ConfirmAction
                          action={base + '/clients/' + encodeURIComponent(client.id) + '/delete'}
                          label="Delete"
                          destructive
                          description="Delete this client and its issued tokens. This cannot be undone."
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title={clients.length ? 'No matching clients' : 'No OAuth clients yet'}
            detail="Create a client to connect ChatGPT or another trusted MCP consumer."
            action={
              clients.length ? (
                <Button variant="outline" size="sm" onClick={() => setFilter('')}>
                  Clear search
                </Button>
              ) : null
            }
          />
        )}
      </Section>
      <div className="mt-5">
        <SecurityNote>
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="size-4" />
            Only approved scopes are granted. Secrets are never displayed again after creation or
            rotation.
          </span>
        </SecurityNote>
      </div>
      <SecretDialog secret={state?.secret} />
    </div>
  );
}
