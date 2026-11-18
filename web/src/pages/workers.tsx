import { useState } from 'react';
import { Activity, Plus, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/app-context';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  ConfirmAction,
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
  const [selectedWorker, setSelectedWorker] = useState<string>('');
  const [targetEnabled, setTargetEnabled] = useState(true);
  const workers = state?.data.workers || [];
  const profiles = state?.data.profiles || [];
  const base = personal ? '/account' : '/admin';
  const available = workers.filter((w) => w.connected && w.enabled);
  const releaseApproved = state?.data.release?.productionDistributionApproved || false;

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
        description="Outbound execution agents, private workspace profiles and verified connection status."
        action={
          <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw className="size-4" />
            Refresh status
          </Button>
        }
      />
      <div className="mb-5 grid gap-4 md:grid-cols-3">
        <Section title="Enrolled Workers">
          <p className="text-2xl font-semibold">{workers.length}</p>
          <p className="mt-1 text-xs text-muted-foreground">Total known execution agents</p>
        </Section>
        <Section title="Connected">
          <p className="text-2xl font-semibold">{workers.filter((w) => w.connected).length}</p>
          <p className="mt-1 text-xs text-muted-foreground">Authenticated outbound WSS</p>
        </Section>
        <Section title="Execution profiles">
          <p className="text-2xl font-semibold">{profiles.length}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Scoped to {personal ? 'your account' : 'Admin'}
          </p>
        </Section>
      </div>
      {!releaseApproved && (
        <Alert className="mb-5">
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
                          <p className="max-w-52 truncate font-mono text-[11px] text-muted-foreground">
                            {worker.id}
                          </p>
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
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          disabled={working === worker.id}
                          size="sm"
                          variant="outline"
                          onClick={() => void probe(worker.id)}
                        >
                          {working === worker.id ? 'Checking…' : 'Probe'}
                        </Button>
                        <FormDialog
                          title="Rename Worker"
                          action={base + '/workers/' + encodeURIComponent(worker.id) + '/edit'}
                          trigger={
                            <Button size="sm" variant="outline">
                              Rename
                            </Button>
                          }
                        >
                          <Field label="Worker name">
                            <Input
                              name="name"
                              defaultValue={worker.name}
                              required
                              maxLength={100}
                            />
                          </Field>
                        </FormDialog>
                        <ConfirmAction
                          label={worker.enabled ? 'Disable' : 'Enable'}
                          action={
                            base +
                            '/workers/' +
                            encodeURIComponent(worker.id) +
                            '/' +
                            (worker.enabled ? 'disable' : 'enable')
                          }
                        />
                        <ConfirmAction
                          label="Remove"
                          destructive
                          action={base + '/workers/' + encodeURIComponent(worker.id) + '/remove'}
                          title="Uninstall and remove Worker?"
                          description="The Worker must be online to safely uninstall itself."
                        />
                        <ConfirmAction
                          label="Force remove"
                          destructive
                          action={
                            base + '/workers/' + encodeURIComponent(worker.id) + '/force-remove'
                          }
                          title="Force delete Worker record?"
                          description="Remote files may remain on the Worker machine."
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
            title="No Workers enrolled"
            detail={
              personal
                ? 'A host operator can provision an isolated Worker for your approved account.'
                : 'Enroll a trusted outbound Worker, then create an execution profile.'
            }
          />
        )}
      </Section>
      <Section
        className="mt-5"
        title={'Execution profiles (' + profiles.length + ')'}
        description="Only profiles owned by your account may be used."
        action={
          <FormDialog
            title="Create execution profile"
            description="A connected Worker is required."
            action={base + '/workers/profiles'}
            submitLabel="Create profile"
            trigger={
              <Button size="sm" disabled={!available.length}>
                <Plus className="size-4" />
                New profile
              </Button>
            }
          >
            <Field label="Name">
              <Input name="name" required maxLength={100} placeholder="Dev workspace" />
            </Field>
            <Field label="Description">
              <Input name="description" maxLength={500} placeholder="Optional description" />
            </Field>
            <Field label="Worker">
              <Select
                name="worker_id"
                required
                defaultValue={available[0]?.id || ''}
                value={selectedWorker || undefined}
                onValueChange={setSelectedWorker}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a connected Worker" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((w) => (
                    <SelectItem value={w.id} key={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm">
              Enabled
              <Switch checked={targetEnabled} onCheckedChange={setTargetEnabled} />
            </label>
            <input type="hidden" name="enabled" value={targetEnabled ? 'true' : 'false'} />
          </FormDialog>
        }
      >
        {profiles.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Profile</TableHead>
                  <TableHead>Worker</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell>
                      <p className="text-sm font-medium">{profile.name}</p>
                      {profile.description && (
                        <p className="text-xs text-muted-foreground">{profile.description}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {profile.worker_name || profile.worker_id}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={profile.enabled ? 'active' : 'disabled'} />
                    </TableCell>
                    <TableCell className="text-end">
                      <ConfirmAction
                        destructive
                        label="Delete"
                        action={
                          base + '/workers/profiles/' + encodeURIComponent(profile.id) + '/delete'
                        }
                        description="The execution profile is removed. The Worker stays enrolled."
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title="No execution profiles"
            detail="Connect a Worker to create a scoped execution target."
          />
        )}
      </Section>
      <div className="mt-5">
        <SecurityNote>
          <Activity className="inline size-4" /> Execution remains subject to authenticated OAuth
          scopes, Worker ownership and isolation policy. Tenant Workers cannot access the host
          Docker socket.
        </SecurityNote>
      </div>
      <EnrollmentDialog enrollment={state?.enrollment} />
    </div>
  );
}
