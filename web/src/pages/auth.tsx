import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, CheckCircle2, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useApp } from '@/app-context';
import { postAuth } from '@/lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { FormInput, CopyValue } from '@/components/common';

function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background px-4 py-10">
      <Link className="mb-8 inline-flex items-center gap-3" to="/login">
        <div className="grid size-11 place-items-center rounded-xl border border-border bg-secondary font-bold">
          MW
        </div>
        <div>
          <p className="text-sm font-bold tracking-tight">mcp_worker</p>
          <p className="text-xs text-muted-foreground">Centralized MCP Platform</p>
        </div>
      </Link>
      <Card className="w-full max-w-[430px] border-border/80 shadow-xl shadow-black/5 dark:shadow-black/20">
        <CardHeader className="space-y-2 pb-1">
          <h1 className="text-xl font-semibold">{title}</h1>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="size-4" />
        Secure account access · OAuth 2.0 / PKCE
      </p>
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { state } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const target = await postAuth(
        '/login',
        {
          username: String(form.get('username') || ''),
          password: String(form.get('password') || ''),
          returnTo: params.get('returnTo') || '',
        },
        state.csrfToken,
      );
      navigate(target, { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      title="Sign in"
      description="Use your approved account to manage tools and ChatGPT connections."
    >
      {state?.role && (
        <Alert className="mb-4">
          <CheckCircle2 className="size-4" />
          <AlertTitle>Already signed in</AlertTitle>
          <AlertDescription>
            <Link className="underline" to={state.role === 'admin' ? '/admin' : '/account'}>
              Go to your workspace
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Sign in failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <form onSubmit={(event) => void login(event)} className="space-y-4">
        <FormInput
          label="Username"
          name="username"
          autoComplete="username"
          required
          minLength={3}
        />
        <FormInput
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Button disabled={busy} className="w-full" type="submit">
          <LockKeyhole className="size-4" />
          {busy ? 'Signing in…' : 'Sign in'}
          <ArrowRight className="ms-auto size-4" />
        </Button>
      </form>
      <p className="mt-5 text-center text-xs text-muted-foreground">
        Need an account?{' '}
        <Link to="/register" className="font-medium text-foreground underline underline-offset-4">
          Request access
        </Link>
      </p>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const { state } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state) return;
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const target = await postAuth(
        '/register',
        {
          username: String(values.username || ''),
          email: String(values.email || ''),
          display_name: String(values.display_name || ''),
          password: String(values.password || ''),
        },
        state.csrfToken,
      );
      navigate(target);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      title="Create an account"
      description="Register once. Your account is activated after administrator approval."
    >
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Registration failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {state?.registrationEnabled ? (
        <form onSubmit={(event) => void register(event)} className="space-y-4">
          <FormInput
            label="Username"
            name="username"
            autoComplete="username"
            required
            minLength={3}
            maxLength={64}
          />
          <FormInput
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            maxLength={254}
            required
          />
          <FormInput label="Display name" name="display_name" maxLength={120} required />
          <FormInput
            label="Password (10+ characters)"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={256}
            required
          />
          <Button disabled={busy} className="w-full" type="submit">
            {busy ? 'Submitting…' : 'Request access'}
            <ArrowRight className="ms-auto size-4" />
          </Button>
        </form>
      ) : (
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertTitle>Registration closed</AlertTitle>
          <AlertDescription>
            An administrator has temporarily disabled new registrations.
          </AlertDescription>
        </Alert>
      )}
      <p className="mt-5 text-center text-xs text-muted-foreground">
        Already approved?{' '}
        <Link to="/login" className="font-medium text-foreground underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

export function RegistrationPendingPage() {
  return (
    <AuthLayout
      title="Registration received"
      description="Your account is waiting for administrator approval."
    >
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <div className="grid size-14 place-items-center rounded-full bg-emerald-500/10">
          <CheckCircle2 className="size-7 text-emerald-500" />
        </div>
        <p className="text-sm text-muted-foreground">
          Once approved, sign in to access your MCP tools and connect ChatGPT. No VPS setup is
          required.
        </p>
        <Button asChild className="w-full">
          <Link to="/login">Back to sign in</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}

export function ConsentPage() {
  const { state, error } = useApp();
  const consent = state?.data.consent;
  if (!consent)
    return (
      <AuthLayout
        title="Authorization unavailable"
        description={error || 'The OAuth request could not be verified.'}
      >
        <Button asChild variant="outline">
          <Link to="/login">Sign in</Link>
        </Button>
      </AuthLayout>
    );
  return (
    <AuthLayout
      title="Authorize MCP access"
      description="Review the access requested by this application before continuing."
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-secondary/30 p-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{consent.clientName}</p>
            <p className="mt-0.5 break-all text-xs text-muted-foreground">{consent.redirectUri}</p>
          </div>
          <KeyRound className="size-6 shrink-0 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium">Requested permissions</p>
          <div className="flex flex-wrap gap-1.5">
            {consent.scopes.map((scope) => (
              <Badge variant="outline" key={scope}>
                {scope}
              </Badge>
            ))}
          </div>
        </div>
        <CopyValue value={consent.resource} label="Copy MCP URL" />
        <Alert>
          <ShieldCheck className="size-4" />
          <AlertTitle>Scope-bound access</AlertTitle>
          <AlertDescription>
            Authorization is bound to your identity, this MCP resource and a PKCE challenge. Access
            can be revoked later.
          </AlertDescription>
        </Alert>
        <form action="/oauth/authorize" method="post" className="flex gap-2">
          <input type="hidden" name="_csrf" value={state?.csrfToken || ''} />
          {[
            'client_id',
            'redirect_uri',
            'scope',
            'state',
            'code_challenge',
            'code_challenge_method',
            'resource',
          ].map((key) => (
            <input
              key={key}
              type="hidden"
              name={key}
              value={String(consent[key as keyof typeof consent])}
            />
          ))}
          <Button variant="outline" className="flex-1" type="submit" name="action" value="deny">
            Deny
          </Button>
          <Button className="flex-1" type="submit" name="action" value="allow">
            Authorize
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
