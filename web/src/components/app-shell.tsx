import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useTheme } from 'next-themes';
import {
  Activity,
  ChevronDown,
  CircleHelp,
  Database,
  Home,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Moon,
  Plug,
  Server,
  Settings2,
  ShieldCheck,
  Sun,
  TerminalSquare,
  UserCircle,
  Users,
} from 'lucide-react';
import { useApp } from '@/app-context';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import type { Role } from '@/types';

type IconType = typeof Home;
type NavItem = { label: string; href: string; icon: IconType };
type NavGroup = { title: string; items: NavItem[] };
const adminGroups: NavGroup[] = [
  {
    title: 'General',
    items: [
      { label: 'Overview', href: '/admin', icon: LayoutDashboard },
      { label: 'Users', href: '/admin/users', icon: Users },
      { label: 'Activity', href: '/admin/audit', icon: Activity },
    ],
  },
  {
    title: 'Configuration',
    items: [
      { label: 'OAuth Clients', href: '/admin/clients', icon: KeyRound },
      { label: 'Workers', href: '/admin/workers', icon: Server },
    ],
  },
  {
    title: 'System',
    items: [
      { label: 'Settings', href: '/admin/settings/database', icon: Settings2 },
      { label: 'Getting Started', href: '/admin/onboarding', icon: CircleHelp },
    ],
  },
];
const userGroups: NavGroup[] = [
  {
    title: 'Workspace',
    items: [
      { label: 'Home', href: '/account', icon: Home },
      { label: 'Connect ChatGPT', href: '/account/connect', icon: Plug },
      { label: 'My Tools', href: '/account/tools', icon: TerminalSquare },
      { label: 'Activity', href: '/account/activity', icon: Activity },
    ],
  },
  { title: 'Account', items: [{ label: 'Profile', href: '/account/profile', icon: UserCircle }] },
  {
    title: 'Advanced',
    items: [
      { label: 'OAuth Clients', href: '/account/clients', icon: KeyRound },
      { label: 'Workers', href: '/account/workers', icon: Server },
      { label: 'Telegram', href: '/account/telegram', icon: Settings2 },
    ],
  },
];

function AppNavigation({ role }: { role: Exclude<Role, null> }) {
  const { setOpenMobile } = useSidebar();
  const currentPath = useLocation().pathname;
  const { state, submit, busy } = useApp();
  const groups = role === 'admin' ? adminGroups : userGroups;
  return (
    <Sidebar collapsible="icon" className="border-e border-border/70">
      <SidebarHeader className="px-3 py-4">
        <Link
          to={role === 'admin' ? '/admin' : '/account'}
          className="flex items-center gap-3 px-2 py-1"
        >
          <div className="flex size-9 items-center justify-center rounded-xl border border-border bg-secondary text-sm font-bold tracking-tight">
            MW
          </div>
          <div className="min-w-0 space-y-0.5 group-data-[collapsible=icon]:hidden">
            <p className="text-sm font-bold tracking-tight">mcp_worker</p>
            <p className="text-[11px] text-muted-foreground">
              {role === 'admin' ? 'Administration' : 'User Workspace'}
            </p>
          </div>
        </Link>
      </SidebarHeader>
      <Separator className="opacity-60" />
      <SidebarContent className="px-2" role="navigation" aria-label="Primary navigation">
        {groups.map((group) => (
          <SidebarGroup key={group.title}>
            <SidebarGroupLabel className="text-[10px] uppercase tracking-widest">
              {group.title}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      tooltip={item.label}
                      isActive={currentPath === item.href}
                    >
                      <NavLink
                        to={item.href}
                        end={item.href === '/admin' || item.href === '/account'}
                        onClick={() => setOpenMobile(false)}
                        className="flex items-center gap-2 rounded-lg"
                        aria-label={item.label}
                      >
                        <item.icon className="size-4" />
                        <span>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="space-y-2 p-3">
        <div className="flex items-center gap-2 rounded-lg border border-sidebar-border/80 bg-sidebar-accent/30 p-2 group-data-[collapsible=icon]:hidden">
          <span className="size-2 rounded-full bg-emerald-500" />
          <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground">
            MCP Service
          </span>
          <Badge variant="outline" className="text-[10px]">
            {state?.storage.state === 'READY' ? 'Ready' : 'Check'}
          </Badge>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign out"
              disabled={busy}
              onClick={() => {
                void submit('/logout')
                  .then(() => {
                    window.location.assign('/login');
                  })
                  .catch(() => {});
              }}
            >
              <LogOut className="size-4" />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function BreadcrumbTitle() {
  const location = useLocation();
  const { state } = useApp();
  const groups = state?.role === 'admin' ? adminGroups : userGroups;
  const active = groups
    .flatMap((group) => group.items)
    .find((item) => item.href === location.pathname);
  const section = location.pathname.startsWith('/admin/settings/')
    ? 'Settings'
    : active?.label || 'Workspace';
  return <span className="truncate text-sm font-medium">{section}</span>;
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Switch theme"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export function AppShell({ role, children }: { role: Exclude<Role, null>; children: ReactNode }) {
  const { state, submit } = useApp();
  return (
    <SidebarProvider defaultOpen>
      <AppNavigation role={role} />
      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border/70 bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-7">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <Separator orientation="vertical" className="h-5" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">mcp_worker</span>
            <span className="hidden text-muted-foreground sm:inline">/</span>
            <BreadcrumbTitle />
          </div>
          <Badge variant="outline" className="hidden gap-1.5 text-xs sm:inline-flex">
            <span
              className={
                state?.storage.state === 'READY'
                  ? 'size-1.5 rounded-full bg-emerald-400'
                  : 'size-1.5 rounded-full bg-amber-400'
              }
            />
            {state?.storage.state === 'READY' ? 'Healthy' : 'Check storage'}
          </Badge>
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2 px-2">
                <Avatar className="size-7">
                  <AvatarFallback className="text-xs">
                    {state?.identity?.username?.slice(0, 2).toUpperCase() || 'MW'}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden max-w-28 truncate text-xs md:inline">
                  {state?.identity?.username}
                </span>
                <ChevronDown className="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>
                {state?.identity?.username} · {role}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {role === 'user' && (
                <DropdownMenuItem asChild>
                  <Link to="/account/profile">
                    <UserCircle className="size-4" />
                    My profile
                  </Link>
                </DropdownMenuItem>
              )}
              {role === 'admin' && (
                <DropdownMenuItem asChild>
                  <Link to="/admin/settings/database">
                    <Database className="size-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => {
                  void submit('/logout')
                    .then(() => window.location.assign('/login'))
                    .catch(() => {});
                }}
              >
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <div className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-7 md:px-8 md:py-8">
          {children}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 px-5 py-3 text-[11px] text-muted-foreground md:px-8">
          <span>mcp_worker · Centralized MCP Platform</span>
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-3" />
            Secured by OAuth + PKCE
          </span>
        </footer>
      </SidebarInset>
    </SidebarProvider>
  );
}
