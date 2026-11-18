import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import {
  Check,
  Clipboard,
  ExternalLink,
  Info,
  LoaderCircle,
  Plus,
  ShieldAlert,
} from 'lucide-react';
import { useApp } from '@/app-context';
import { cn } from '@/lib/utils';
import { WorkerLoginGuide } from '@/components/worker-install-guide';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  useEffect(() => {
    document.title = title + ' · MCP Worker';
  }, [title]);
  return (
    <div className="mb-7 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-[1.7rem] font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('gap-5 border-border/90 shadow-none [--card-spacing:--spacing(6)]', className)}>
      {(title || description || action) && (
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            {title && <h2 className="text-[0.95rem] font-semibold">{title}</h2>}
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {action}
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function MetricCard({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: string | number;
  note?: string;
  icon?: ReactNode;
}) {
  return (
    <Card className="gap-2 border-border/90 py-5 shadow-none">
      <CardHeader className="flex items-center justify-between gap-3 py-0">
        <CardDescription className="text-xs font-medium">{label}</CardDescription>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent className="space-y-1 pt-1">
        <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardContent>
    </Card>
  );
}

export function StatusBadge({ status }: { status: string | boolean | undefined | null }) {
  const value = String(status ?? 'unknown');
  const positive =
    status === true ||
    [
      'active',
      'online',
      'healthy',
      'READY',
      'SUCCESS',
      'enabled',
      'Connected',
      'Isolated',
    ].includes(value);
  const negative = ['disabled', 'revoked', 'rejected', 'ERROR', 'DENIED', 'offline'].includes(
    value,
  );
  return (
    <Badge
      variant={positive ? 'secondary' : negative ? 'destructive' : 'outline'}
      className="font-medium capitalize"
    >
      {positive && <span className="me-1 inline-block size-1.5 rounded-full bg-emerald-400" />}
      {value}
    </Badge>
  );
}

export function CopyValue({
  value,
  label = 'Copy',
  masked = false,
  className,
}: {
  value: string;
  label?: string;
  masked?: boolean;
  className?: string;
}) {
  const [revealed, setRevealed] = useState(!masked);
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs">
        {revealed ? value : '•'.repeat(Math.min(value.length, 32))}
      </code>
      {masked && (
        <Button type="button" variant="outline" size="sm" onClick={() => setRevealed(!revealed)}>
          {revealed ? 'Hide' : 'Show'}
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        type="button"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => toast.success('Copied to clipboard'))
            .catch(() => toast.error('Copy failed'));
        }}
      >
        <Clipboard className="size-4" />
        <span className="hidden sm:inline">{label}</span>
      </Button>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/80 px-6 py-8 text-center">
      <Info className="mb-1 size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      {detail && <p className="max-w-md text-xs text-muted-foreground">{detail}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Field({
  label,
  children,
  description,
}: {
  label: string;
  children: ReactNode;
  description?: string;
}) {
  const id = useId();
  const control =
    isValidElement<{ name?: string; id?: string }>(children) && children.props.name
      ? cloneElement(children, { id })
      : children;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
      </Label>
      {control}
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

export function FormInput({
  label,
  name,
  type = 'text',
  required,
  defaultValue,
  placeholder,
  ...props
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string | number;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  autoComplete?: string;
  readOnly?: boolean;
}) {
  return (
    <Field label={label}>
      <Input
        type={type}
        name={name}
        aria-label={label}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        {...props}
      />
    </Field>
  );
}

export function ActionForm({
  action,
  children,
  onDone,
  submitLabel = 'Save',
  className,
}: {
  action: string;
  children: ReactNode;
  submitLabel?: string;
  className?: string;
  onDone?: () => void;
}) {
  const { submit, busy } = useApp();
  const [pending, setPending] = useState(false);
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      await submit(action, new FormData(event.currentTarget));
      onDone?.();
    } catch {
      /* app provider already shows request error */
    } finally {
      setPending(false);
    }
  }
  return (
    <form className={cn('space-y-4', className)} onSubmit={(event) => void run(event)}>
      {children}
      <Button disabled={pending || busy} type="submit">
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
        {submitLabel}
      </Button>
    </form>
  );
}

export function FormDialog({
  title,
  description,
  action,
  trigger,
  children,
  submitLabel = 'Save',
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  description?: string;
  action: string;
  trigger?: ReactNode;
  children: ReactNode;
  submitLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { submit, busy } = useApp();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(value);
    else onOpenChange?.(value);
  };
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && (pending || busy)) return;
    if (!nextOpen && dirty) {
      toast.info('Unsaved changes. Use Cancel to discard them.');
      return;
    }
    setOpen(nextOpen);
  }
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      await submit(action, new FormData(event.currentTarget));
      setDirty(false);
      setOpen(false);
    } catch {
      /* Error is shown by submit(). */
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="max-h-[88vh] overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          onSubmit={(event) => void run(event)}
          onChangeCapture={() => setDirty(true)}
          className="space-y-4"
        >
          {children}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending || busy}
              onClick={() => {
                setDirty(false);
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || busy}>
              {pending && <LoaderCircle className="size-4 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmAction({
  action,
  label,
  title,
  description,
  destructive = false,
  variant = 'outline',
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  action: string;
  label: string;
  title?: string;
  description?: string;
  destructive?: boolean;
  variant?: 'outline' | 'ghost' | 'destructive';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const { submit, busy } = useApp();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(value);
    else onOpenChange?.(value);
  };
  const [pending, setPending] = useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && (pending || busy)) return;
        setOpen(nextOpen);
      }}
    >
      {!hideTrigger && (
        <AlertDialogTrigger asChild>
          <Button variant={variant} size="sm" disabled={busy}>
            {label}
          </Button>
        </AlertDialogTrigger>
      )}
      <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title || label + '?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {description || 'This action affects the selected resource.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy || pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || pending}
            onClick={(event) => {
              event.preventDefault();
              if (pending || busy) return;
              setPending(true);
              void submit(action)
                .then(() => setOpen(false))
                .catch(() => {})
                .finally(() => setPending(false));
            }}
          >
            {pending && <LoaderCircle className="size-4 animate-spin" />}
            Confirm {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SecretDialog({
  secret,
  mcpUrl,
}: {
  secret: { clientId: string; clientSecret: string } | null | undefined;
  mcpUrl: string;
}) {
  const [open, setOpen] = useState(Boolean(secret));
  useEffect(() => {
    if (secret) setOpen(true);
  }, [secret]);
  if (!secret) return null;
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => nextOpen && setOpen(true)}>
      <DialogContent showCloseButton={false} className="max-h-[88vh] overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>OAuth client credentials</DialogTitle>
          <DialogDescription>
            The secret is only available once. Copy it now and keep it private.
          </DialogDescription>
        </DialogHeader>
        <Field label="MCP Server URL">
          <CopyValue value={mcpUrl} label="Copy MCP URL" />
        </Field>
        <Field label="Client ID">
          <CopyValue value={secret.clientId} />
        </Field>
        <Field label="Client secret">
          <CopyValue value={secret.clientSecret} masked label="Copy secret" />
        </Field>
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>I've saved the secret</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EnrollmentDialog({
  enrollment,
  mcpEndpoint,
}: {
  enrollment: { token: string; expires_at: string } | null | undefined;
  mcpEndpoint: string;
}) {
  const [open, setOpen] = useState(Boolean(enrollment));
  useEffect(() => {
    if (enrollment) setOpen(true);
  }, [enrollment]);
  if (!enrollment) return null;
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => nextOpen && setOpen(true)}>
      <DialogContent showCloseButton={false} className="max-h-[88vh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>One-time Worker enrollment</DialogTitle>
          <DialogDescription>
            This token will not be shown again. Enroll only your trusted Worker. Signed public
            installers remain gated.
          </DialogDescription>
        </DialogHeader>
        <Field label="Enrollment token">
          <CopyValue value={enrollment.token} masked label="Copy token" />
        </Field>
        <p className="text-xs text-muted-foreground">Expires: {enrollment.expires_at}</p>
        <div className="border-t border-border pt-4">
          <WorkerLoginGuide mcpEndpoint={mcpEndpoint} />
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DetailRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
      <span className="text-xs text-muted-foreground">{name}</span>
      <div className="min-w-0 text-sm font-medium">{children}</div>
    </div>
  );
}

export function ExternalDocumentation({ href, label }: { href: string; label: string }) {
  return (
    <a
      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label}
      <ExternalLink className="size-3.5" />
    </a>
  );
}

export function SecurityNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function AddButton({ children }: { children: ReactNode }) {
  return (
    <Button>
      <Plus className="size-4" />
      {children}
    </Button>
  );
}
