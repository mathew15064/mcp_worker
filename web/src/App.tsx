import { BrowserRouter, Link, Navigate, useLocation } from 'react-router-dom';
import { ThemeProvider } from 'next-themes';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import { AppProvider, useApp } from '@/app-context';
import { AppShell } from '@/components/app-shell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AdminOverview, AdminOnboarding, AdminSettings, AdminUsers } from '@/pages/admin';
import { LoginPage, RegisterPage, RegistrationPendingPage, ConsentPage } from '@/pages/auth';
import { ClientsPage } from '@/pages/clients';
import { WorkersPage } from '@/pages/workers';
import { ActivityPage } from '@/pages/activity';
import { TelegramPanel } from '@/pages/telegram';
import { UserHome, ConnectChatGPT, MyTools, MyAccount } from '@/pages/user';

function LoadingScreen() {
  return (
    <div className="flex min-h-svh items-center justify-center gap-3 text-sm text-muted-foreground">
      <LoaderCircle className="size-5 animate-spin" />
      Loading workspace…
    </div>
  );
}

function Routing() {
  const { state, loading, error, refresh } = useApp();
  const { pathname } = useLocation();
  if (loading) return <LoadingScreen />;
  if (error && !state)
    return (
      <div className="mx-auto flex min-h-svh max-w-xl items-center px-5">
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Unable to load MCP Worker</AlertTitle>
          <AlertDescription>
            {error}
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  if (pathname === '/login') return <LoginPage />;
  if (pathname === '/register') return <RegisterPage />;
  if (pathname === '/registration-pending') return <RegistrationPendingPage />;
  if (pathname === '/oauth/authorize') return <ConsentPage />;
  if (pathname === '/admin/settings') return <Navigate replace to="/admin/settings/database" />;
  if (pathname === '/account/home') return <Navigate replace to="/account" />;
  if (pathname === '/account/profile/advanced') return <Navigate replace to="/account/profile" />;
  if (pathname === '/admin/telegram') return <Navigate replace to="/admin/settings/telegram" />;

  const role = state?.role;
  if (!role) return <Navigate replace to={'/login?returnTo=' + encodeURIComponent(pathname)} />;
  if (pathname.startsWith('/admin') && role !== 'admin') return <Navigate replace to="/account" />;
  if (pathname.startsWith('/account') && role !== 'user') return <Navigate replace to="/admin" />;

  let content: React.ReactNode;
  switch (pathname) {
    case '/admin':
      content = <AdminOverview />;
      break;
    case '/admin/users':
      content = <AdminUsers />;
      break;
    case '/admin/onboarding':
      content = <AdminOnboarding />;
      break;
    case '/admin/clients':
      content = <ClientsPage />;
      break;
    case '/admin/workers':
      content = <WorkersPage />;
      break;
    case '/admin/audit':
      content = <ActivityPage />;
      break;
    case '/account':
      content = <UserHome />;
      break;
    case '/account/connect':
      content = <ConnectChatGPT />;
      break;
    case '/account/tools':
      content = <MyTools />;
      break;
    case '/account/activity':
      content = <ActivityPage personal />;
      break;
    case '/account/clients':
      content = <ClientsPage personal />;
      break;
    case '/account/workers':
      content = <WorkersPage personal />;
      break;
    case '/account/telegram':
      content = <TelegramPanel personal asPage />;
      break;
    case '/account/profile':
      content = <MyAccount />;
      break;
    default:
      if (pathname.startsWith('/admin/settings/')) content = <AdminSettings />;
      else
        content = (
          <div className="space-y-3">
            <h1 className="text-xl font-semibold">Page not found</h1>
            <p className="text-sm text-muted-foreground">
              This page is not available in your workspace.
            </p>
            <Button asChild variant="outline">
              <Link to={role === 'admin' ? '/admin' : '/account'}>Back to workspace</Link>
            </Button>
          </div>
        );
  }

  return (
    <AppShell role={role}>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="size-4" />
          <AlertTitle>Unable to refresh page</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {content}
    </AppShell>
  );
}

export default function App() {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      storageKey="mcp_worker-theme"
    >
      <TooltipProvider>
        <BrowserRouter>
          <AppProvider>
            <Routing />
          </AppProvider>
          <Toaster position="bottom-right" richColors closeButton />
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  );
}
