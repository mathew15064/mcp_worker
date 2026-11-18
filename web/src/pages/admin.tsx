import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  Database,
  KeyRound,
  Plus,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { useApp } from '@/app-context';
import { RowActions } from '@/components/row-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ActionForm,
  CopyValue,
  DetailRow,
  EmptyState,
  FormDialog,
  FormInput,
  MetricCard,
  PageHeading,
  Section,
  SecurityNote,
  StatusBadge,
} from '@/components/common';
import { TelegramPanel } from '@/pages/telegram';
import type { User } from '@/types';

export function AdminOverview() {
  const { state } = useApp();
  const clients = state?.data.clients || [];
  const workers = state?.data.workers || [];
  const active = clients.filter((c) => c.status === 'active').length;
  const online = workers.filter((w) => w.connected).length;
  const runtime = state?.runtime;
  return (
    <div>
      <PageHeading
        title="Overview"
        description="Monitor the MCP gateway and its connected resources."
        action={
          <Button asChild variant="outline">
            <Link to="/admin/onboarding">
              Getting Started
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        }
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Data Store"
          value={state?.storage.state === 'READY' ? 'SQLite' : 'Check'}
          note="Persistent local database"
          icon={<Database className="size-4" />}
        />
        <MetricCard
          label="MCP Tools"
          value={runtime?.toolCount || 0}
          note="Available primitives"
          icon={<ShieldCheck className="size-4" />}
        />
        <MetricCard
          label="OAuth Clients"
          value={clients.length}
          note={active + ' active'}
          icon={<KeyRound className="size-4" />}
        />
        <MetricCard
          label="Workers"
          value={workers.length}
          note={online + ' connected'}
          icon={<Server className="size-4" />}
        />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          title="Runtime Information"
          description="Identity of the currently deployed MCP service."
        >
          <DetailRow name="Application">
            <span>mcp_worker</span>
          </DetailRow>
          <DetailRow name="Version">
            <span>v{runtime?.version || '—'}</span>
          </DetailRow>
          <DetailRow name="Git SHA">
            <code className="break-all text-xs">{runtime?.gitSha || 'unknown'}</code>
          </DetailRow>
          <DetailRow name="Build time">{runtime?.buildTime || 'unknown'}</DetailRow>
          <DetailRow name="Started at">
            {runtime?.startedAt ? new Date(runtime.startedAt).toLocaleString() : 'unknown'}
          </DetailRow>
          <DetailRow name="Environment">{runtime?.nodeEnv || 'development'}</DetailRow>
        </Section>
        <Section
          title="System configuration"
          description="Status of the services used by the MCP gateway."
        >
          {[
            {
              label: 'Database',
              path: '/admin/settings/database',
              note: 'SQLite application store',
              ready: state?.storage.state === 'READY',
            },
            {
              label: 'OAuth clients',
              path: '/admin/clients',
              note: 'Authorization for remote MCP',
              ready: active > 0,
            },
            {
              label: 'Workers',
              path: '/admin/workers',
              note: 'Outbound authenticated WSS',
              ready: online > 0,
            },
            {
              label: 'Telegram',
              path: '/admin/settings/telegram',
              note: 'Optional notification channel',
              ready: Boolean(state?.data.telegram?.enabled && state.data.telegram?.hasToken),
            },
          ].map((item) => (
            <Link
              to={item.path}
              key={item.label}
              className="flex items-center justify-between gap-3 border-b border-border/60 py-3 last:border-0 hover:text-primary"
            >
              <span>
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{item.note}</span>
              </span>
              <StatusBadge status={item.ready ? 'active' : 'Unconfigured'} />
            </Link>
          ))}
        </Section>
      </div>
      <Section
        className="mt-5"
        title="MCP endpoint"
        description="Canonical resource URL for ChatGPT and other authorized MCP clients."
      >
        <CopyValue value={state?.endpoint || '/mcp'} label="Copy URL" />
      </Section>
    </div>
  );
}

export function AdminUsers() {
  const { state, submit, busy } = useApp();
  const users = state?.data.users || [];
  const [filter, setFilter] = useState('');
  const [registration, setRegistration] = useState(state?.data.registrationEnabled || false);
  const [execution, setExecution] = useState(state?.data.hostedExecutionEnabled || false);
  const visible = users.filter((u) =>
    [u.username, u.display_name, u.email, u.status]
      .join(' ')
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  return (
    <div>
      <PageHeading
        title="Users"
        description="Review registrations, approve accounts and revoke access."
        action={
          <FormDialog
            title="Create user"
            description="Create an active user account for the hosted platform."
            action="/admin/users"
            trigger={
              <Button>
                <Plus className="size-4" />
                Create user
              </Button>
            }
            submitLabel="Create active user"
          >
            <FormInput label="Username" name="username" minLength={3} maxLength={64} required />
            <FormInput label="Email" name="email" type="email" maxLength={254} />
            <FormInput label="Display name" name="display_name" maxLength={120} required />
            <FormInput
              label="Initial password"
              name="password"
              type="password"
              minLength={10}
              maxLength={256}
              required
            />
          </FormDialog>
        }
      />
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Section
          title="Public registration"
          description="New accounts still require administrator approval."
        >
          <div className="flex min-h-10 items-center justify-between gap-5">
            <span className="text-sm">Allow account requests</span>
            <Switch
              aria-label="Allow account requests"
              checked={registration}
              onCheckedChange={setRegistration}
            />
          </div>
          <Button
            className="mt-5"
            size="sm"
            disabled={busy}
            onClick={() => void submit('/admin/registration', { enabled: registration })}
          >
            Save registration policy
          </Button>
        </Section>
        <Section
          title="Hosted execution"
          description="Terminal use requires attested, isolated per-user Workers."
        >
          <div className="flex min-h-10 items-center justify-between gap-5">
            <span className="text-sm">Enable verified execution</span>
            <Switch
              aria-label="Enable verified execution"
              checked={execution}
              onCheckedChange={setExecution}
            />
          </div>
          <Button
            className="mt-5"
            size="sm"
            disabled={busy}
            onClick={() => void submit('/admin/hosted', { enabled: execution })}
          >
            Save execution policy
          </Button>
        </Section>
      </div>
      <Section
        title={'All users (' + users.length + ')'}
        action={
          <Input
            className="w-52"
            aria-label="Search users"
            placeholder="Search users…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        }
      >
        {visible.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((user: User) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <span className="block text-sm font-medium">{user.username}</span>
                      <span className="text-xs text-muted-foreground">{user.display_name}</span>
                    </TableCell>
                    <TableCell className="text-xs">{user.email || '—'}</TableCell>
                    <TableCell>
                      <StatusBadge status={user.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'Never'}
                    </TableCell>
                    <TableCell>
                      <RowActions
                        resource={user.username}
                        actions={[
                          ...(user.status !== 'active'
                            ? [{
                                kind: 'confirm' as const,
                                label: 'Approve',
                                action: '/admin/users/' + encodeURIComponent(user.id) + '/approve',
                                description: 'Allow this account to sign in and connect OAuth clients.',
                              }]
                            : []),
                          {
                            kind: 'form',
                            label: 'Reset password',
                            title: 'Reset password · ' + user.username,
                            action: '/admin/users/' + encodeURIComponent(user.id) + '/reset-password',
                            submitLabel: 'Reset password',
                            children: (
                              <>
                                <FormInput
                                  label="New password"
                                  name="password"
                                  type="password"
                                  minLength={10}
                                  maxLength={256}
                                  required
                                />
                                <SecurityNote>
                                  Existing sessions and OAuth grants are revoked after reset.
                                </SecurityNote>
                              </>
                            ),
                          },
                          {
                            kind: 'confirm',
                            label: user.status === 'disabled' ? 'Enable' : 'Disable',
                            destructive: user.status !== 'disabled',
                            action: '/admin/users/' + encodeURIComponent(user.id) + '/' +
                              (user.status === 'disabled' ? 'enable' : 'disable'),
                            description: 'Disabling a user revokes sessions, OAuth tokens and disconnects their Worker.',
                          },
                          ...(user.status === 'pending'
                            ? [{
                                kind: 'confirm' as const,
                                label: 'Reject',
                                destructive: true,
                                action: '/admin/users/' + encodeURIComponent(user.id) + '/reject',
                              }]
                            : []),
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title={users.length ? 'No matching users' : 'No users yet'}
            detail="New registrations will appear here for approval."
          />
        )}
      </Section>
    </div>
  );
}

export function AdminOnboarding() {
  const { state } = useApp();
  const clients = state?.data.clients || [];
  const workers = state?.data.workers || [];
  const profiles = state?.data.profiles || [];
  const ready = state?.storage.state === 'READY';
  const clientReady = clients.some(
    (c) => c.status === 'active' && c.allowed_scopes.includes('mcp_worker.read'),
  );
  const connected = workers.filter((w) => w.connected && w.enabled);
  const workerReady = profiles.some(
    (profile) => profile.enabled && connected.some((worker) => worker.id === profile.worker_id),
  );
  const steps = [
    {
      title: 'Initialize SQLite',
      text: 'Application storage is ready.',
      okay: ready,
      href: '/admin/settings/database',
    },
    {
      title: 'Configure MCP',
      text: 'Confirm the public endpoint and OAuth discovery.',
      okay: Boolean(state?.endpoint),
      href: '/admin/settings/mcp',
    },
    {
      title: 'Create OAuth client',
      text: 'Register an authorized MCP consumer.',
      okay: clientReady,
      href: '/admin/clients',
    },
    {
      title: 'Connect Worker',
      text: 'Enroll a trusted Worker over outbound WebSocket.',
      okay: workerReady,
      href: '/admin/workers',
    },
    {
      title: 'Make first MCP call',
      text: 'Verify runtime_info on an authorized client.',
      okay: Boolean(state?.data.firstCall),
      href: '/admin/audit',
    },
    {
      title: 'Verify ChatGPT externally',
      text: 'Connect using ChatGPT and confirm the complete OAuth flow.',
      okay: false,
      href: '/admin/clients',
    },
  ];
  return (
    <div>
      <PageHeading
        title="Getting Started"
        description="Six setup checks with explicit verification gates."
      />
      <Alert className="mb-5">
        <CircleHelp className="size-4" />
        <AlertTitle>External ChatGPT verification is manual</AlertTitle>
        <AlertDescription>
          OAuth discovery alone does not prove that ChatGPT can finish authorization. The final step
          remains unverified until tested in ChatGPT.
        </AlertDescription>
      </Alert>
      <div className="grid gap-3">
        {steps.map((step, i) => (
          <Card
            key={step.title}
            className="py-4"
            data-onboarding-step={i + 1}
            data-state={step.okay ? 'ready' : 'pending'}
          >
            <CardContent className="flex flex-wrap items-center gap-4">
              <div
                className={
                  'grid size-9 place-items-center rounded-full border text-sm font-semibold ' +
                  (step.okay
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                    : 'bg-secondary text-muted-foreground')
                }
              >
                {step.okay ? <CheckCircle2 className="size-5" /> : i + 1}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{step.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{step.text}</p>
              </div>
              <Badge variant={step.okay ? 'secondary' : 'outline'}>
                {step.okay ? 'Ready' : 'Pending'}
              </Badge>
              <Button asChild variant="outline" size="sm">
                <Link to={step.href}>
                  Open
                  <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <Section className="mt-5" title="Canonical MCP resource">
        <CopyValue value={state?.endpoint || '/mcp'} label="Copy URL" />
      </Section>
      <p className="mt-4 text-xs text-muted-foreground" data-chatgpt-verification="unverified">
        ChatGPT status: unverified — use a real external client for final acceptance.
      </p>
    </div>
  );
}

export function AdminSettings() {
  const { state } = useApp();
  const pathname = useLocation().pathname;
  const section = pathname.split('/').pop() || 'database';
  const mcp = state?.data.mcp;
  const [mcpEnabled, setMcpEnabled] = useState(mcp?.enabled ?? true);
  const tabs = [
    { id: 'database', name: 'Database' },
    { id: 'mcp', name: 'MCP' },
    { id: 'telegram', name: 'Telegram' },
    { id: 'runtime', name: 'Runtime' },
  ];
  return (
    <div>
      <PageHeading
        title="Settings"
        description="Manage runtime, MCP, database and operational configuration."
      />
      <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Settings sections">
        {tabs.map((tab) => (
          <Button
            asChild
            key={tab.id}
            size="sm"
            role="tab"
            aria-selected={tab.id === section}
            variant={section === tab.id ? 'secondary' : 'outline'}
          >
            <Link to={'/admin/settings/' + tab.id}>{tab.name}</Link>
          </Button>
        ))}
      </div>
      {section === 'database' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Section title="SQLite storage" description="Current database health and readiness.">
            <DetailRow name="State">
              <StatusBadge status={state?.storage.state} />
            </DetailRow>
            <DetailRow name="Engine">SQLite (better-sqlite3)</DetailRow>
            <DetailRow name="Mode">Local persistent volume</DetailRow>
            {state?.storage.lastError?.message && (
              <Alert variant="destructive" className="mt-4">
                <AlertTitle>Database error</AlertTitle>
                <AlertDescription>{state.storage.lastError.message}</AlertDescription>
              </Alert>
            )}
          </Section>
          <Section title="Data integrity">
            <SecurityNote>
              Database initialization and migration remain server-side operations. This UI never
              resets existing application data.
            </SecurityNote>
            <div className="mt-4">
              <Button asChild variant="outline">
                <Link to="/admin/onboarding">View readiness checks</Link>
              </Button>
            </div>
          </Section>
        </div>
      )}
      {section === 'mcp' && (
        <Section
          title="MCP service configuration"
          description="Settings are persisted on the Express backend."
        >
          <ActionForm
            action="/admin/settings/mcp"
            submitLabel="Save MCP settings"
            className="max-w-xl"
          >
            <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
              Enable MCP service <Switch checked={mcpEnabled} onCheckedChange={setMcpEnabled} />
            </label>
            <input type="hidden" name="enabled" value={mcpEnabled ? 'true' : 'false'} />
            <FormInput
              label="Public Base URL"
              name="public_base_url"
              type="url"
              defaultValue={mcp?.publicBaseUrl || ''}
              required
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput
                label="Access token TTL (seconds)"
                name="access_token_ttl_seconds"
                type="number"
                min={60}
                max={86400}
                defaultValue={mcp?.accessTokenTtlSeconds || 900}
              />
              <FormInput
                label="Refresh token TTL (seconds)"
                name="refresh_token_ttl_seconds"
                type="number"
                min={3600}
                max={31536000}
                defaultValue={mcp?.refreshTokenTtlSeconds || 2592000}
              />
              <FormInput
                label="Auth code TTL (seconds)"
                name="auth_code_ttl_seconds"
                type="number"
                min={60}
                max={3600}
                defaultValue={mcp?.authCodeTtlSeconds || 300}
              />
              <FormInput
                label="Rate limit / minute"
                name="rate_limit_per_minute"
                type="number"
                min={1}
                max={10000}
                defaultValue={mcp?.rateLimitPerMinute || 120}
              />
            </div>
            <SecurityNote>
              OAuth scopes and token ownership are enforced server-side. Changing the public URL
              affects ChatGPT discovery.
            </SecurityNote>
          </ActionForm>
        </Section>
      )}
      {section === 'telegram' && <TelegramPanel config={state?.data.telegram} />}
      {section === 'runtime' && (
        <Section title="Runtime details" description="Version and build provenance.">
          <DetailRow name="Application">mcp_worker</DetailRow>
          <DetailRow name="Version">{state?.runtime.version}</DetailRow>
          <DetailRow name="Git SHA">
            <code className="break-all text-xs">{state?.runtime.gitSha || 'unknown'}</code>
          </DetailRow>
          <DetailRow name="Build time">{state?.runtime.buildTime || 'unknown'}</DetailRow>
          <DetailRow name="Environment">{state?.runtime.nodeEnv}</DetailRow>
          <DetailRow name="MCP Tools">{state?.runtime.toolCount}</DetailRow>
          <DetailRow name="Storage">
            <StatusBadge status={state?.storage.state} />
          </DetailRow>
        </Section>
      )}
      {!tabs.some((tab) => tab.id === section) && (
        <EmptyState title="Unknown settings section" detail="Select a valid section above." />
      )}
    </div>
  );
}
