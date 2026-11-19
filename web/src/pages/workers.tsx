import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Ban, CircleCheck, Copy, Pencil, Plus, RefreshCw, ScanSearch, Server, ShieldCheck, ShieldX, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { WorkerInstallGuide } from '@/components/worker-install-guide';
import { RowActions } from '@/components/row-actions';
import { useApp } from '@/app-context';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  EnrollmentDialog,
  Field,
  FormDialog,
  PageHeading,
  SecurityNote,
  Section,
  StatusBadge,
} from '@/components/common';

export function WorkersPage({ personal = false }: { personal?: boolean }) {
  const { state, refresh, busy } = useApp();
  const [working, setWorking] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  const activeTab = tab === 'install' ? 'install' : 'workers';
  const selectedTabRef = useRef(activeTab);
  selectedTabRef.current = activeTab;
  const workers = state?.data.workers || [];
  const base = personal ? '/account' : '/admin';
  const releaseApproved = state?.data.release?.productionDistributionApproved || false;

  function selectTab(value: string) {
    if (value !== 'workers' && value !== 'install') return;
    // Radix pointer + focus events can both request the same tab before navigation renders.
    if (selectedTabRef.current === value) return;
    selectedTabRef.current = value;
    const params = new URLSearchParams(searchParams);
    params.set('tab', value);
    setSearchParams(params, { preventScrollReset: true });
  }

  async function probe(id: string) {
    setWorking(id);
    try {
      const r = await fetch(base + '/workers/connection-status?check=' + encodeURIComponent(id), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!r.ok) throw new Error('Connection probe failed (HTTP ' + r.status + ').');
      const data = (await r.json()) as {
        probe?: { ok: boolean; latency_ms?: number };
        workers: { id: string; connected: boolean }[];
      };
      const connected = data.workers.find((w) => w.id === id)?.connected;
      if (connected && data.probe?.ok)
        toast.success('Worker online · ' + (data.probe.latency_ms ?? '—') + ' ms');
      else if (connected) toast.success('Worker reports online');
      else toast.error('Worker is offline');
      await refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Probe failed.');
    } finally {
      setWorking(null);
    }
  }

  return (
    <div>
      <PageHeading
        title={personal ? 'My Workers' : 'Workers'}
        description="Manage connected execution Workers and verify their status."
        action={
          <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw className="size-4" />
            Refresh status
          </Button>
        }
      />
      <Tabs value={activeTab} onValueChange={selectTab} className="min-w-0 gap-5">
        <TabsList aria-label="Worker sections" className="grid h-12 w-full max-w-md grid-cols-2 gap-1 rounded-xl border border-border/80 bg-muted/80 p-1 shadow-sm">
          <TabsTrigger value="workers" className="h-full min-w-0 rounded-lg px-3 text-xs font-semibold data-active:border-border/70 data-active:bg-background data-active:shadow-sm sm:text-sm">
            <Server className="size-4" />
            Workers
          </TabsTrigger>
          <TabsTrigger value="install" className="h-full min-w-0 rounded-lg px-3 text-xs font-semibold data-active:border-border/70 data-active:bg-background data-active:shadow-sm sm:text-sm">
            <Plus className="size-4" />
            Install Worker
          </TabsTrigger>
        </TabsList>
        <TabsContent value="workers" className="min-w-0 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Section title="Enrolled Workers">
              <p className="text-2xl font-semibold">{workers.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">Total known execution agents</p>
            </Section>
            <Section title="Connected">
              <p className="text-2xl font-semibold">{workers.filter((w) => w.connected).length}</p>
              <p className="mt-1 text-xs text-muted-foreground">Authenticated outbound WSS</p>
            </Section>
          </div>
          <Section
            title={'Workers (' + workers.length + ')'}
            description="Live connection status is verified with the Worker broker."
            action={
              !personal ? (
                <FormDialog
                  title="Generate one-time Worker enrollment"
                  action="/admin/workers/enrollment"
                  trigger={
                    <Button size="sm">
                      <Plus className="size-4" />
                      Enroll Worker
                    </Button>
                  }
                  submitLabel="Generate token"
                >
                  <Field label="Lifetime (seconds)">
                    <Input name="ttl_seconds" type="number" min={60} max={3600} defaultValue={600} />
                  </Field>
                  <SecurityNote>
                    Token can be used once. It is not an approval to publish unsigned Worker binaries.
                  </SecurityNote>
                </FormDialog>
              ) : null
            }
          >
            {workers.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Worker</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Isolation</TableHead>
                      <TableHead>Last seen</TableHead>
                      <TableHead className="text-end">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {workers.map((worker) => (
                      <TableRow key={worker.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="grid size-8 place-items-center rounded-md border">
                              <Server className="size-4 text-muted-foreground" />
                            </div>
                            <div>
                              <p className="text-sm font-medium">{worker.name}</p>
                              <button
                                type="button"
                                title={worker.id}
                                aria-label={'Copy Worker ID for ' + worker.name}
                                className="flex max-w-52 items-center gap-1 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                  void navigator.clipboard.writeText(worker.id)
                                    .then(() => toast.success('Worker ID copied'))
                                    .catch(() => toast.error('Copy failed'));
                                }}
                              >
                                <span className="min-w-0 truncate">{worker.id}</span>
                                <Copy className="size-3 shrink-0" />
                              </button>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={worker.connected ? 'online' : 'offline'} />
                          {!worker.enabled && (
                            <Badge variant="outline" className="ms-1">
                              Disabled
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={worker.hosted_isolated ? 'Isolated' : 'Unattested'} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {worker.last_seen_at
                            ? new Date(worker.last_seen_at).toLocaleString()
                            : 'Never'}
                        </TableCell>
                        <TableCell>
                          <RowActions
                            resource={worker.name}
                            actions={[
                              {
                                kind: 'callback',
                                label: working === worker.id ? 'Checking…' : 'Probe',
                                icon: ScanSearch,
                                disabled: working === worker.id,
                                onSelect: () => { void probe(worker.id); },
                              },
                              {
                                kind: 'form',
                                label: 'Rename',
                                icon: Pencil,
                                title: 'Rename Worker',
                                action: base + '/workers/' + encodeURIComponent(worker.id) + '/edit',
                                children: (
                                  <Field label="Worker name">
                                    <Input
                                      name="name"
                                      defaultValue={worker.name}
                                      required
                                      maxLength={100}
                                    />
                                  </Field>
                                ),
                              },
                              {
                                kind: 'confirm',
                                label: worker.enabled ? 'Disable' : 'Enable',
                                icon: worker.enabled ? Ban : CircleCheck,
                                action: base + '/workers/' + encodeURIComponent(worker.id) + '/' +
                                  (worker.enabled ? 'disable' : 'enable'),
                              },
                              {
                                kind: 'confirm',
                                label: 'Remove',
                                icon: Trash2,
                                action: base + '/workers/' + encodeURIComponent(worker.id) + '/remove',
                                title: 'Uninstall and remove Worker?',
                                description: 'The Worker must be online to safely uninstall itself.',
                                destructive: true,
                              },
                              {
                                kind: 'confirm',
                                label: 'Force remove',
                                icon: ShieldX,
                                action: base + '/workers/' + encodeURIComponent(worker.id) + '/force-remove',
                                title: 'Force delete Worker record?',
                                description: 'Remote files may remain on the Worker machine.',
                                destructive: true,
                              },
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
                title="No Workers enrolled"
                detail={
                  personal
                    ? 'A host operator can provision an isolated Worker for your approved account.'
                    : 'Enroll a trusted outbound Worker to make it available as an execution target.'
                }
              />
            )}
          </Section>
        </TabsContent>
        <TabsContent value="install" className="min-w-0 space-y-5">
          {!releaseApproved && (
            <Alert>
              <ShieldCheck className="size-4" />
              <AlertTitle>Public Worker distribution gated</AlertTitle>
              <AlertDescription>
                Public one-command installers are unavailable pending signed release approval.
                {personal
                  ? ' Hosted execution is provisioned by the host operator after your account is approved.'
                  : ' Admin development enrollment tokens remain available for trusted manually built Workers.'}
              </AlertDescription>
            </Alert>
          )}
          <Section
            title="Install Worker"
            description="Step-by-step installation for Linux, macOS and Windows, with an explanation and a separate Copy button for each command."
          >
            <WorkerInstallGuide mcpEndpoint={state?.endpoint || ''} />
          </Section>
        </TabsContent>
      </Tabs>
      <div className="mt-5">
        <SecurityNote>
          <Activity className="inline size-4" /> Execution remains subject to authenticated OAuth
          scopes, Worker ownership and isolation policy. Tenant Workers cannot access the host
          Docker socket.
        </SecurityNote>
      </div>
      <EnrollmentDialog enrollment={state?.enrollment} mcpEndpoint={state?.endpoint || ''} />
    </div>
  );
}
