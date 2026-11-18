import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/app-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, PageHeading, Section, StatusBadge } from '@/components/common';

export function ActivityPage({ personal = false }: { personal?: boolean }) {
  const { state } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [result, setResult] = useState(searchParams.get('result') || 'all');
  const [client, setClient] = useState(searchParams.get('client_id') || 'all');
  const [tool, setTool] = useState(searchParams.get('tool_name') || 'all');
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const logs = state?.data.logs || [];
  const total = state?.data.total ?? logs.length;
  const page = state?.data.page || 1;
  const maxPage = Math.max(1, Math.ceil(total / (state?.data.perPage || 20)));

  function goPage(newPage: number, overrides: Record<string, string> = {}) {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(overrides)) {
      if (value && value !== 'all') params.set(key, value);
      else params.delete(key);
    }
    if (newPage > 1) params.set('page', String(newPage));
    else params.delete('page');
    navigate('/admin/audit' + (params.size ? '?' + params.toString() : ''));
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    goPage(1, { q: query, result, client_id: client, tool_name: tool });
  }
  async function viewDetail(id: string) {
    setDetailLoading(true);
    try {
      const response = await fetch('/admin/audit/' + encodeURIComponent(id), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Audit detail not available.');
      setDetail((await response.json()) as Record<string, unknown>);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Unable to load audit record.');
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div>
      <PageHeading
        title={personal ? 'My Activity' : 'Activity'}
        description={
          personal
            ? 'Recent MCP requests for your account only.'
            : 'Trace MCP requests, outcomes, client identities and sanitized request details.'
        }
      />
      {!personal && (
        <Section className="mb-5" title="Filters">
          <form
            onSubmit={search}
            className="grid items-end gap-3 md:grid-cols-[2fr_1fr_1fr_1fr_auto]"
          >
            <div className="space-y-1.5">
              <Label htmlFor="audit-search">Search</Label>
              <div className="relative">
                <Search className="absolute start-3 top-2.5 size-4 text-muted-foreground" />
                <Input
                  id="audit-search"
                  className="ps-9"
                  placeholder="Request, method, tool..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  maxLength={160}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Client</Label>
              <Select value={client} onValueChange={setClient}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All clients" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All clients</SelectItem>
                  {(state?.data.clients || []).map((c) => (
                    <SelectItem key={c.client_id} value={c.client_id}>
                      {c.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tool</Label>
              <Select value={tool} onValueChange={setTool}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All tools" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tools</SelectItem>
                  {(state?.data.toolNames || []).map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Result</Label>
              <Select value={result} onValueChange={setResult}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All results</SelectItem>
                  {['SUCCESS', 'DENIED', 'ERROR'].map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit">Apply</Button>
          </form>
        </Section>
      )}
      <Section
        title={personal ? 'Recent requests' : 'Audit log (' + total + ' events)'}
        description={
          personal
            ? 'Activity cannot be read by another user.'
            : 'Showing ' + logs.length + ' records on page ' + page + '.'
        }
      >
        {logs.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  {!personal && <TableHead>Client</TableHead>}
                  <TableHead>MCP Method</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>HTTP</TableHead>
                  {!personal && <TableHead>Details</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log, i) => (
                  <TableRow key={log.id || i}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {log.created_at ? new Date(log.created_at).toLocaleString() : '—'}
                      {!personal && (
                        <p className="max-w-36 truncate font-mono text-[10px] text-muted-foreground">
                          {log.request_id}
                        </p>
                      )}
                    </TableCell>
                    {!personal && (
                      <TableCell>
                        <p className="text-xs font-medium">
                          {log.client_display_name || log.client_id || 'Unknown'}
                        </p>
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-xs">{log.mcp_method || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{log.tool_name || '—'}</TableCell>
                    <TableCell>
                      <StatusBadge status={log.result} />
                    </TableCell>
                    <TableCell className="tabular-nums text-xs">{log.http_status ?? '—'}</TableCell>
                    {!personal && (
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={detailLoading}
                          onClick={() => log.id && void viewDetail(log.id)}
                        >
                          View
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title="No activity yet"
            detail="MCP requests will be recorded here after a client connects."
          />
        )}
        {!personal && maxPage > 1 && (
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Page {page} of {maxPage}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={page <= 1}
                size="sm"
                onClick={() => goPage(page - 1)}
              >
                <ChevronLeft className="size-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={page >= maxPage}
                size="sm"
                onClick={() => goPage(page + 1)}
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </Section>
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Audit event detail</DialogTitle>
            <DialogDescription>Sanitized request metadata and response payload.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[55vh] overflow-auto rounded-lg border border-border bg-secondary/50 p-3 text-xs whitespace-pre-wrap break-words">
            {JSON.stringify(detail, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
