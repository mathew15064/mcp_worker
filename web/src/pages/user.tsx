import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CheckCircle2,
  KeyRound,
  LockKeyhole,
  Plug,
  ShieldCheck,
  TerminalSquare,
  UserRound,
} from 'lucide-react';
import { useApp } from '@/app-context';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ActionForm,
  CopyValue,
  DetailRow,
  FormInput,
  MetricCard,
  PageHeading,
  Section,
  SecurityNote,
  StatusBadge,
} from '@/components/common';

export function UserHome() {
  const { state } = useApp();
  const user = state?.identity;
  return (
    <div>
      <PageHeading
        title={'Welcome, ' + (user?.display_name || user?.username || 'User')}
        description="Your managed MCP workspace. No VPS, Docker or DNS setup required."
        action={
          <Button asChild>
            <Link to="/account/connect">
              <Plug className="size-4" />
              Connect ChatGPT
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        }
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <MetricCard
          label="Account"
          value="Active"
          icon={<UserRound className="size-4" />}
          note="Approved user identity"
        />
        <MetricCard
          label="OAuth clients"
          value={state?.data.clientCount || 0}
          icon={<KeyRound className="size-4" />}
          note="Personal client credentials"
        />
        <MetricCard
          label="MCP tools"
          value={state?.runtime.toolCount || 15}
          icon={<TerminalSquare className="size-4" />}
          note="Scope and isolation restrictions apply"
        />
      </div>
      <Section
        title="Your MCP endpoint"
        description="Connect ChatGPT once using the shared hosted URL."
      >
        <CopyValue value={state?.endpoint || '/mcp'} label="Copy MCP URL" />
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/account/connect">
              Connection instructions
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/account/tools">View my tools</Link>
          </Button>
        </div>
      </Section>
      <div className="mt-5">
        <SecurityNote>
          Tool execution is restricted to your own identity and approved execution profiles. Hosted
          terminal access is disabled unless a verified, isolated Worker is provisioned.
        </SecurityNote>
      </div>
    </div>
  );
}

export function ConnectChatGPT() {
  const { state } = useApp();
  const steps = [
    { title: 'Copy MCP URL', description: 'Use this same hosted URL for every approved account.' },
    {
      title: 'Add MCP connector in ChatGPT',
      description: 'Enter the URL in your workspace’s connector settings.',
    },
    {
      title: 'Complete OAuth authorization',
      description: 'Sign in using your approved MCP Worker account and review scopes.',
    },
    {
      title: 'Use MCP tools',
      description: 'Read tools are available; terminal tools require separate worker provisioning.',
    },
  ];
  return (
    <div>
      <PageHeading
        title="Connect ChatGPT"
        description="Add the hosted MCP gateway with no self-hosted infrastructure."
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,1fr)]">
        <Section
          title="MCP connection URL"
          description="Canonical resource address for your ChatGPT connector."
        >
          <CopyValue value={state?.endpoint || '/mcp'} label="Copy URL" />
          <p className="mt-4 text-sm text-muted-foreground">
            Once entered in ChatGPT, continue with OAuth and sign in as{' '}
            <strong className="text-foreground">{state?.identity?.username}</strong>. Dynamic public
            client registration uses PKCE and grants read scope only.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/account/clients">
                Advanced OAuth clients
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/account/tools">My Tools</Link>
            </Button>
          </div>
        </Section>
        <Section title="Connection checklist" description="Four steps to access your workspace.">
          <div className="space-y-4">
            {steps.map((step, index) => (
              <div className="flex gap-3" key={step.title}>
                <div className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-secondary text-xs font-semibold">
                  {index + 1}
                </div>
                <div>
                  <p className="text-sm font-medium">{step.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
      <Alert className="mt-5">
        <ShieldCheck className="size-4" />
        <AlertTitle>Your access stays isolated</AlertTitle>
        <AlertDescription>
          ChatGPT authorization is bound to your account. Terminal access requires an explicit
          trusted client scope and verified per-user runtime.
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function MyTools() {
  const { state } = useApp();
  const tools = state?.data.tools || [];
  const enabled = state?.data.hasWorker || false;
  return (
    <div>
      <PageHeading
        title="My Tools"
        description="MCP tools available through your identity and permission scopes."
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <Section title="Read tools" description="Discovery and information under read scope.">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-500" />
            <span className="text-sm font-medium">runtime_info available</span>
          </div>
        </Section>
        <Section
          title="Execution tools"
          description="Terminal, file, Git and managed process operations."
        >
          <div className="flex items-center gap-2">
            <LockKeyhole className="size-5 text-muted-foreground" />
            <StatusBadge status={enabled ? 'Isolated' : 'Disabled'} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {enabled
              ? 'An authorized Personal Worker or attested Hosted Worker is configured. Your OAuth client must still have terminal scope.'
              : 'Your host operator must provision and attest an isolated Worker before execution is allowed.'}
          </p>
        </Section>
      </div>
      <Section
        title={'MCP catalog (' + tools.length + ' tools)'}
        description="Availability depends on the scope of the client and execution target."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {tools.map((tool) => (
            <div key={tool.name} className="min-w-0 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="break-all text-xs font-medium">{tool.name}</code>
                <Badge variant={tool.name === 'runtime_info' ? 'secondary' : 'outline'}>
                  {tool.name === 'runtime_info' ? 'Read' : 'Terminal scope'}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{tool.description || 'MCP tool'}</p>
            </div>
          ))}
        </div>
      </Section>
      <div className="mt-5">
        <SecurityNote>
          Only your own Worker profiles are accessible. Read scope does not grant shell or
          file-writing access.
        </SecurityNote>
      </div>
    </div>
  );
}

export function MyAccount() {
  const { state } = useApp();
  const user = state?.identity;
  return (
    <div>
      <PageHeading title="Account" description="Manage your personal profile and security." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="My profile" description="Your approved account identity.">
          <ActionForm action="/account/profile" submitLabel="Save profile">
            <input type="hidden" name="return_to" value="/account/profile" />
            <FormInput
              label="Username"
              name="username_readonly"
              defaultValue={user?.username}
              readOnly
            />
            <FormInput
              label="Display name"
              name="display_name"
              defaultValue={user?.display_name || user?.username}
              maxLength={120}
              required
            />
            <FormInput
              label="Email"
              name="email"
              defaultValue={user?.email || ''}
              maxLength={254}
              type="email"
            />
          </ActionForm>
          <div className="mt-5 border-t border-border pt-2">
            <DetailRow name="Role">
              <Badge variant="secondary">{user?.role || 'user'}</Badge>
            </DetailRow>
            <DetailRow name="Account status">
              <StatusBadge status={user?.status || 'active'} />
            </DetailRow>
            <DetailRow name="Principal ID">
              <code className="max-w-72 break-all text-xs">{user?.principal_id}</code>
            </DetailRow>
            <DetailRow name="Profile ID">
              <code className="max-w-72 break-all text-xs">{user?.profile_id}</code>
            </DetailRow>
          </div>
        </Section>
        <Section
          title="Security"
          description="Update your password and revoke all active sessions."
        >
          <ActionForm action="/account/password" submitLabel="Change password and sign out">
            <input type="hidden" name="return_to" value="/account/profile" />
            <FormInput
              label="New password (10+ characters)"
              name="password"
              type="password"
              minLength={10}
              maxLength={256}
              autoComplete="new-password"
              required
            />
          </ActionForm>
          <div className="mt-5">
            <SecurityNote>
              Changing your password ends current sessions and revokes OAuth tokens. You will need
              to sign in again.
            </SecurityNote>
          </div>
        </Section>
      </div>
    </div>
  );
}
