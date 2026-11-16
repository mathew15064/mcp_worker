/* Typed HTML rendering contract. Every dynamic value is escaped at the output boundary. */
import {
  workerDistributionBlocked,
  workerSignedReleaseReadiness,
} from '../services/workerReleaseGate';
type HtmlValue = unknown;
interface PageUser {
  id?: string;
  username?: string;
  display_name?: string | null;
  email?: string | null;
  principal_id?: string | null;
  profile_id?: string | null;
  status?: string;
  last_login_at?: string | null;
}
interface PageClient {
  id: string;
  client_id: string;
  display_name: string;
  principal_id: string;
  status: string;
  allowed_scopes: string[];
  redirect_uris: string[];
  last_authorized_at?: string | null;
  owner_user_id?: string | null;
  profile_id?: string | null;
}
interface PageProfile {
  id: string;
  name: string;
  worker_id: string;
  enabled: number | boolean;
  description?: string | null;
  worker_name?: string | null;
  worker_enabled?: number | boolean;
  worker_status?: string | null;
}
interface PageWorker {
  id: string;
  name: string;
  enabled: number | boolean;
  status?: string;
  last_seen_at?: string | null;
  capabilities?: unknown[];
  owner_user_id?: string | null;
  owner_display_name?: string | null;
  owner_username?: string | null;
}
interface PageSecret {
  clientId: string;
  clientSecret: string;
}
interface PageTelegram {
  enabled: boolean;
  hasToken: boolean;
  chatId: string;
}
interface PageRuntime {
  version: string;
  gitSha?: string | null;
  buildTime?: string | null;
  startedAt?: string | null;
  nodeEnv?: string;
  toolCount: number;
}
interface PageStorage {
  state: string;
  engine?: string | null;
  operational?: boolean;
  source?: { initialized?: boolean; pending?: unknown[] } | null;
  lastError?: { message?: string } | null;
}
interface PageAudit {
  id: string;
  request_id?: string;
  result: string;
  client_display_name?: string | null;
  client_id?: string | null;
  created_at?: string | null;
  request_truncated?: boolean;
  response_truncated?: boolean;
  mcp_method?: string | null;
  tool_name?: string | null;
  http_status?: number;
  duration_ms?: number;
}
interface PageFilters {
  query: string;
  clientId: string;
  toolName: string;
  result: string;
}
interface PageMcp {
  enabled: boolean;
  publicBaseUrl: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  rateLimitPerMinute: number;
}
interface PageShell {
  admin?: boolean;
  accountUser?: PageUser | null;
  active?: string;
  settingsSection?: string;
  csrfToken?: string;
  breadcrumb?: string;
  extraHead?: string;
  extraScripts?: string;
}
function escapeHtml(value: HtmlValue) {
  const printable =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
        ? String(value)
        : '';
  return printable
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function icon(name: string) {
  const paths: Record<string, string> = {
    dashboard:
      '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m12 12 9-9m-3 3 3 3m-6 0 3 3"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    server:
      '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>',
    refresh:
      '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6l-2 3M5.5 15A7 7 0 0 0 18 18l2-3"/>',
    power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    external:
      '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    logout: '<path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-6"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M14 9l-3 3 3 3"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.4v-4h.09A1.7 1.7 0 0 0 4.2 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.6 4.2a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.4h4v.09A1.7 1.7 0 0 0 15 4.2a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8.6a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.09v4h-.09a1.7 1.7 0 0 0-1.7 1Z"/>',
    database:
      '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.server}</svg>`;
}

function navLink(active: string, key: string, href: string, label: string, iconName: string) {
  return `<a class="nav-link ${active === key ? 'active' : ''}" href="${href}" aria-current="${active === key ? 'page' : 'false'}" title="${escapeHtml(label)}">${icon(iconName)}<span>${escapeHtml(label)}</span></a>`;
}

function settingsSubnav(activeSection: string = '') {
  const items = [
    ['database', 'Database', 'database'],
    ['mcp', 'MCP', 'server'],
    ['telegram', 'Telegram', 'send'],
    ['runtime', 'Runtime', 'settings'],
  ];
  return `<nav class="nav-submenu" aria-label="Settings navigation">${items.map(([key, label, iconName]) => `<a class="nav-sub-link ${activeSection === key ? 'active' : ''}" href="/admin/settings/${key}" ${activeSection === key ? 'aria-current="page"' : ''}>${icon(iconName)}<span>${label}</span></a>`).join('')}</nav>`;
}

function confirmModal() {
  return `<div id="confirm-modal" class="modal-backdrop" aria-hidden="true"><div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message"><div class="modal-header"><h2 id="confirm-title">Confirm action</h2><p id="confirm-message">Are you sure?</p></div><div class="modal-footer"><button type="button" class="btn" data-modal-close>Cancel</button><button id="confirm-action" type="button" class="btn btn-primary">Continue</button></div></div></div>`;
}

function flashData(success: string = '', error: string = '') {
  return `<div id="flash-data" hidden data-success="${escapeHtml(success)}" data-error="${escapeHtml(error)}"></div>`;
}

function accountProfileModal(user: PageUser | null, csrfToken: string) {
  if (!user) return '';
  return `<div id="account-profile-modal" class="modal-backdrop" aria-hidden="true"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="account-profile-title" aria-describedby="account-profile-description"><div class="modal-header"><h2 id="account-profile-title">My Profile</h2><p id="account-profile-description">Manage your mcp_worker account and password without leaving the current workspace.</p></div><div class="modal-body"><div class="stack"><form method="post" action="/account/profile" class="stack" data-disable-on-submit><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="return_to" value="" data-account-return-to><div class="form-grid"><div class="field"><label for="account-profile-username">Username</label><input id="account-profile-username" value="${escapeHtml(user.username)}" disabled></div><div class="field"><label for="account-profile-display-name">Display name</label><input id="account-profile-display-name" name="display_name" value="${escapeHtml(user.display_name || user.username)}" required maxlength="120"></div><div class="field full"><label for="account-profile-email">Email</label><input id="account-profile-email" name="email" type="email" value="${escapeHtml(user.email || '')}" maxlength="254"></div></div><div class="modal-inline-actions"><button class="btn btn-primary" type="submit">Save Profile</button></div></form><div class="modal-section-divider"></div><form method="post" action="/account/password" class="stack" data-disable-on-submit><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="return_to" value="" data-account-return-to><div><strong>Security</strong><div class="hint">Changing your password revokes all existing login sessions.</div></div><div class="field"><label for="account-profile-new-password">New password</label><input id="account-profile-new-password" name="password" type="password" minlength="10" maxlength="256" autocomplete="new-password" required></div><div class="modal-inline-actions"><button class="btn" type="submit">Change Password</button></div></form><div class="migration-note"><strong>Client identity</strong><span class="mono">${escapeHtml(user.principal_id)} · ${escapeHtml(user.profile_id)}</span></div></div></div><div class="modal-footer"><button class="btn" type="button" data-modal-close>Close</button></div></div></div>`;
}

function shell(
  title: string,
  body: string,
  {
    admin = false,
    accountUser = null,
    active = '',
    settingsSection = '',
    csrfToken = '',
    breadcrumb = '',
    extraHead = '',
    extraScripts = '',
  }: PageShell = {},
) {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/admin.css">${extraHead}</head><body>`;
  if (!admin)
    return `${head}${body}<div id="toast-stack" class="toast-stack"></div><script src="/assets/admin.js" defer></script>${extraScripts}</body></html>`;
  const nav = accountUser
    ? `<aside id="admin-sidebar" class="sidebar" role="navigation" aria-label="Primary navigation"><div class="brand"><div class="brand-mark">MW</div><div class="brand-copy"><div>mcp_worker</div><div class="brand-sub">User Workspace</div></div><button class="btn btn-icon btn-ghost sidebar-collapse" type="button" data-sidebar-collapse aria-label="Collapse sidebar" title="Collapse sidebar">${icon('panel')}</button></div><div class="nav-group"><div class="nav-label">Workspace</div><nav class="nav">${navLink(active, 'account-clients', '/account/clients', 'My Clients', 'key')}${navLink(active, 'account-workers', '/account/workers', 'Workers', 'server')}${navLink(active, 'account-telegram', '/account/telegram', 'Telegram', 'send')}</nav></div><div class="sidebar-bottom"><button class="runtime-mini account-profile-trigger" type="button" data-modal-open="account-profile-modal" aria-label="Open profile for ${escapeHtml(accountUser.display_name || accountUser.username)}"><div class="runtime-mini-row"><span>${icon('user')} ${escapeHtml(accountUser.display_name || accountUser.username)}</span></div><div class="runtime-mini-row"><span class="muted">Role</span><span>User</span></div></button><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="btn btn-ghost" style="width:100%;justify-content:flex-start" type="submit" title="Sign out">${icon('logout')} <span class="signout-label">Sign out</span></button></form></div></aside><button class="sidebar-scrim" type="button" data-sidebar-scrim aria-label="Close navigation" tabindex="-1"></button>`
    : `<aside id="admin-sidebar" class="sidebar" role="navigation" aria-label="Primary navigation"><div class="brand"><div class="brand-mark">MW</div><div class="brand-copy"><div>mcp_worker</div><div class="brand-sub">Execution Harness</div></div><button class="btn btn-icon btn-ghost sidebar-collapse" type="button" data-sidebar-collapse aria-label="Collapse sidebar" title="Collapse sidebar">${icon('panel')}</button></div><div class="nav-group"><div class="nav-label">General</div><nav class="nav">${navLink(active, 'overview', '/admin', 'Overview', 'dashboard')}${navLink(active, 'onboarding', '/admin/onboarding', 'Getting Started', 'check')}${navLink(active, 'audit', '/admin/audit', 'Audit Log', 'history')}</nav></div><div class="nav-group"><div class="nav-label">Configuration</div><nav class="nav">${navLink(active, 'clients', '/admin/clients', 'OAuth Clients', 'key')}${navLink(active, 'workers', '/admin/workers', 'Workers', 'server')}</nav></div><div class="nav-group"><div class="nav-label">System</div><nav class="nav">${navLink(active, 'settings', '/admin/settings/database', 'Settings', 'settings')}${active === 'settings' ? settingsSubnav(settingsSection) : ''}</nav></div><div class="sidebar-bottom"><div class="runtime-mini"><div class="runtime-mini-row"><span><span class="dot"></span>MCP healthy</span><strong>Worker-only</strong></div><div class="runtime-mini-row"><span class="muted">Mode</span><span>MCP + Admin</span></div></div><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="btn btn-ghost" style="width:100%;justify-content:flex-start" type="submit" title="Sign out">${icon('logout')} <span class="signout-label">Sign out</span></button></form></div></aside><button class="sidebar-scrim" type="button" data-sidebar-scrim aria-label="Close navigation" tabindex="-1"></button>`;
  const top = `<header class="topbar-global"><div class="breadcrumb"><button class="btn btn-icon btn-ghost mobile-menu" type="button" data-mobile-menu aria-label="Open navigation" aria-expanded="false" aria-controls="admin-sidebar">${icon('menu')}</button><span>mcp_worker</span><span>/</span><strong>${escapeHtml(breadcrumb || title)}</strong></div><div class="top-actions"><span class="badge badge-ok"><span class="dot"></span>Healthy</span><button class="btn btn-icon btn-ghost" type="button" data-theme-toggle aria-label="Switch theme">${icon('moon')}</button></div></header>`;
  return `${head}<div class="app-shell">${nav}<div class="main">${top}<main class="content">${body}</main></div></div>${accountUser ? accountProfileModal(accountUser, csrfToken) : ''}${confirmModal()}<div id="toast-stack" class="toast-stack" aria-live="polite" aria-atomic="true"></div><script src="/assets/admin.js" defer></script>${extraScripts}</body></html>`;
}

function pageHeader(title: string, description: string, action: string = '') {
  return `<div class="page-header"><div><h1 class="page-title">${escapeHtml(title)}</h1><p class="page-description">${escapeHtml(description)}</p></div>${action}</div>`;
}

function loginPage({
  csrfToken = '',
  error = '',
  username = '',
  returnTo = '',
}: { csrfToken?: string; error?: string; username?: string; returnTo?: string } = {}) {
  return shell(
    'mcp_worker Login',
    `<div class="login-shell"><div class="login-card"><div class="login-brand"><div class="brand-mark">MW</div><div><strong>mcp_worker</strong><div class="hint">Secure MCP Access</div></div></div><h1>Welcome back</h1><p>Sign in with your mcp_worker account.</p>${error ? `<div class="alert alert-error" role="alert">${escapeHtml(error)}</div>` : ''}<form method="post" action="/login" class="stack" data-disable-on-submit><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><div class="field"><label for="login-username">Username</label><input id="login-username" name="username" autocomplete="username" value="${escapeHtml(username)}" required autofocus></div><div class="field"><label for="login-password">Password</label><input id="login-password" type="password" name="password" autocomplete="current-password" required></div><button class="btn btn-primary" type="submit">Sign in</button></form></div></div>`,
  );
}

function oauthConsentPage({
  client,
  redirectUri,
  resource,
  scopes,
  state,
  codeChallenge,
  codeChallengeMethod,
  csrfToken = '',
}: {
  client: Pick<PageClient, 'client_id' | 'display_name'>;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  csrfToken?: string;
}) {
  const hidden = {
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state: state || '',
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    resource,
  };
  const fields = Object.entries(hidden)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return shell(
    'Authorize MCP Access',
    `<div class="login-shell"><div class="login-card"><div class="login-brand"><div class="brand-mark">MW</div><div><strong>mcp_worker</strong><div class="hint">OAuth authorization</div></div></div><h1>Authorize access</h1><p><strong>${escapeHtml(client.display_name)}</strong> wants to access mcp_worker.</p><div class="section" style="margin:18px 0"><div class="section-body"><div class="definition-label">Resource</div><div class="definition-value mono">${escapeHtml(resource)}</div><div class="definition-label" style="margin-top:14px">Scopes</div><div>${scopes.map((scope) => `<span class="code-chip">${escapeHtml(scope)}</span>`).join('')}</div></div></div><form method="post" action="/oauth/authorize">${fields}<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" type="submit" name="action" value="deny">Deny</button><button class="btn btn-primary" type="submit" name="action" value="allow">Allow access</button></div></form></div></div>`,
  );
}

function statCard(label: string, value: HtmlValue, foot: string, iconName: string) {
  return `<div class="card"><div class="stat-head"><span>${escapeHtml(label)}</span>${icon(iconName)}</div><div class="stat-value">${escapeHtml(value)}</div><div class="stat-foot">${escapeHtml(foot)}</div></div>`;
}

function adminOverviewPage({
  runtime,
  clients,
  workers,
  telegram,
  endpoint,
  storage,
  csrfToken,
  success = '',
  error = '',
}: {
  runtime: PageRuntime;
  clients: PageClient[];
  workers: PageWorker[];
  telegram: PageTelegram;
  endpoint: string;
  storage: PageStorage;
  csrfToken: string;
  success?: string;
  error?: string;
}) {
  const activeClients = clients.filter((c) => c.status === 'active').length;
  const onlineWorkers = workers.filter((w) => w.enabled && w.status === 'online').length;
  const startedAt = runtime.startedAt || 'unknown';
  const storageState = storage.state || 'UNCONFIGURED';
  const storageLabel = storageState === 'READY' ? 'SQLite' : 'Setup required';
  const storageFoot =
    storageState === 'READY' ? 'persistent local database' : 'initialize with ./setup.sh --init';
  const setupNotice =
    storageState === 'READY'
      ? ''
      : `<div class="setup-banner warning"><div>${icon('database')}<div><strong>SQLite database is unavailable</strong><p>${escapeHtml(storage.lastError?.message || 'Run ./setup.sh --init to initialize a fresh SQLite installation.')}</p></div></div></div>`;
  const body = `${flashData(success, error)}${pageHeader('Overview', 'Monitor the mcp_worker runtime and its configuration.', '<a class="btn" href="/admin/onboarding">Getting Started</a>')}${setupNotice}
  <div class="stats-grid">${statCard('Data Store', storageLabel, storageFoot, 'database')}${statCard('MCP Tools', runtime.toolCount, 'available primitives', 'shield')}${statCard('OAuth Clients', clients.length, `${activeClients} active`, 'key')}${statCard('Workers', workers.length, `${onlineWorkers} online`, 'server')}</div>
  <div class="grid-2"><section class="section"><div class="section-header"><div><h2 class="section-title">Runtime Information</h2><p class="section-subtitle">Identity of the currently deployed MCP service.</p></div></div><div class="section-body"><div class="definition-grid"><div class="definition"><div class="definition-label">Application</div><div class="definition-value">mcp_worker</div></div><div class="definition"><div class="definition-label">Version</div><div class="definition-value">v${escapeHtml(runtime.version)}</div></div><div class="definition"><div class="definition-label">Git SHA</div><div class="copy-row"><code id="runtime-sha">${escapeHtml(runtime.gitSha || 'unknown')}</code><button class="btn btn-sm btn-ghost" type="button" data-copy-target="runtime-sha">${icon('copy')} Copy</button></div></div><div class="definition"><div class="definition-label">Build Time</div><div class="definition-value">${escapeHtml(runtime.buildTime || 'unknown')}</div></div><div class="definition"><div class="definition-label">Started At</div><div class="definition-value">${escapeHtml(startedAt)}</div></div><div class="definition"><div class="definition-label">Environment</div><div class="definition-value">${escapeHtml(runtime.nodeEnv || 'production')}</div></div></div></div></section>
  <section class="section"><div class="section-header"><div><h2 class="section-title">System Configuration</h2><p class="section-subtitle">Operational readiness of MCP dependencies.</p></div></div><div class="section-body status-list"><a class="status-row" href="/admin/settings/database"><div><div class="status-row-title">Database</div><div class="status-row-sub">Primary application data store</div></div><span class="badge ${storageState === 'READY' ? 'badge-ok' : 'badge-off'}">${escapeHtml(storageLabel)}</span></a><a class="status-row" href="/admin/clients"><div><div class="status-row-title">OAuth Clients</div><div class="status-row-sub">Remote MCP authorization</div></div><span class="badge ${clients.length ? 'badge-ok' : 'badge-off'}">${clients.length ? 'Configured' : 'Not set'}</span></a><a class="status-row" href="/admin/workers"><div><div class="status-row-title">Workers</div><div class="status-row-sub">Outbound WSS execution targets</div></div><span class="badge ${workers.length ? 'badge-ok' : 'badge-off'}">${workers.length ? 'Configured' : 'Not set'}</span></a><a class="status-row" href="/admin/settings/telegram"><div><div class="status-row-title">Telegram</div><div class="status-row-sub">Optional support notification</div></div><span class="badge ${telegram.enabled && telegram.hasToken && telegram.chatId ? 'badge-ok' : 'badge-off'}">${telegram.enabled && telegram.hasToken && telegram.chatId ? 'Configured' : 'Optional'}</span></a></div></section></div>
  <section id="endpoint" class="section" style="margin-top:16px"><div class="section-header"><div><h2 class="section-title">MCP Endpoint</h2><p class="section-subtitle">Canonical resource URL. MCP configuration is managed from Settings.</p></div><a class="btn btn-sm" href="/admin/settings/mcp">Settings</a></div><div class="section-body"><div class="copy-row"><code id="mcp-endpoint" style="flex:1">${escapeHtml(endpoint)}</code><button class="btn" type="button" data-copy-target="mcp-endpoint">${icon('copy')} Copy URL</button></div></div></section>`;
  return shell('Overview — mcp_worker', body, {
    admin: true,
    active: 'overview',
    csrfToken,
    breadcrumb: 'Overview',
  });
}

function onboardingPage({
  storage,
  ready,
  workerReady,
  clientReady,
  firstCall,
  enabled,
  baseUrl,
  csrfToken,
}: {
  storage: PageStorage;
  ready: boolean;
  workerReady: boolean;
  clientReady: boolean;
  firstCall: boolean;
  enabled: boolean;
  baseUrl: string;
  csrfToken: string;
}) {
  let mode = 'unsafe';
  try {
    const url = new URL(baseUrl);
    if (!url.username && !url.password && !url.search && !url.hash && url.pathname === '/') {
      if (url.protocol === 'https:') mode = 'https';
      else if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
        mode = 'local';
    }
  } catch {}
  // Remote MCP clients require an explicit HTTPS origin; loopback HTTP is for local testing only.
  const endpointReady = ready && enabled && (mode === 'https' || mode === 'local');
  // Same fail-closed distribution gate as the HTTP installer routes.
  // Neither an online Worker nor a read-only MCP call can approve a release.
  const signedReleasePending = workerDistributionBlocked();
  const verifiedWorker = workerReady && !signedReleasePending;
  const next = !ready
    ? 2
    : !endpointReady
      ? 3
      : !verifiedWorker
        ? 4
        : !clientReady
          ? 5
          : !firstCall
            ? 6
            : 0;
  const steps = [
    [
      'Admin sign-in',
      true,
      'You are signed in. Protect the Admin password you chose and your deployment secrets. Back up the persistent database separately; no credentials are shown in this wizard.',
      '/admin/settings/runtime',
      'Runtime settings',
    ],
    [
      'Database readiness',
      ready,
      ready
        ? 'SQLite database is ready.'
        : 'Current state: ' +
          storage.state +
          '. For a new local installation, run ./setup.sh --init. Never overwrite an existing database.',
      '/admin/settings/database',
      'Database settings',
    ],
    [
      'MCP endpoint and transport',
      endpointReady,
      !enabled && ready
        ? 'MCP is disabled. Enable MCP in Settings before authorizing a client.'
        : mode === 'local'
          ? 'Loopback HTTP is for local clients only. Do not expose this port or send credentials over remote HTTP. For a remote connector, configure HTTPS reverse proxy, secure cookies and the public base URL first.'
          : mode === 'https'
            ? 'HTTPS is configured. Verify the certificate, reverse proxy, secure cookies and external reachability separately; this page does not test them.'
            : 'Use a valid HTTPS origin for remote clients or loopback HTTP for local development. Never publish the standalone HTTP port.',
      '/admin/settings/mcp',
      'MCP settings',
    ],
    [
      'Enroll an approved signed Worker',
      ready && verifiedWorker,
      signedReleasePending
        ? 'Blocked: Worker installer returns HTTP 503 (WORKER_SIGNED_RELEASE_PENDING). A signed and approved Worker release is not available. Do not use unsigned downloads or bypass verification. No Worker is installed by this wizard; existing live Workers are not proof of installer approval.'
        : 'Create a short-lived enrollment token in Workers, then install only on a machine you control and log in with an explicit allowed root. Shell authority is powerful; allowed roots are not a sandbox. Enrollment creates a profile automatically, but never installs software or grants shell permission without your action.',
      '/admin/workers',
      'Workers',
    ],
    [
      'Create a read-only OAuth client',
      ready && clientReady,
      'Open the prefilled ChatGPT client form. Confirm its callback against the exact URI shown by ChatGPT; only mcp_worker.read is selected. Copy the one-time Client ID and secret into secure connector fields, never a chat prompt. Client creation alone grants no access.',
      mode === 'local' ? '/admin/clients?first_call=local' : '/admin/clients?first_call=1',
      'OAuth clients',
    ],
    [
      'Verify an authenticated MCP call',
      ready && firstCall,
      'After OAuth consent, call runtime_info with {} from ChatGPT. A successful Admin-owned client audit proves authenticated MCP use, NOT which app made the call. Confirm ChatGPT reports the connection separately before launch.',
      '/admin/audit?tool_name=runtime_info&result=SUCCESS',
      'View audit evidence',
    ],
  ];
  const localHelp =
    mode === 'local' && ready
      ? `<div class="migration-note"><strong>Local first-call helper</strong><span>Register callback <code>http://127.0.0.1:43871/callback</code> with Read scope only. On the same host, from the project directory with Node.js 22 installed, run:</span><code>node dist/scripts/first-mcp-call.js ${escapeHtml(baseUrl)}</code><span>Enter credentials privately, open the displayed authorization URL, approve Read access, and refresh this page. The helper revokes the access token after the call.</span></div>`
      : '';
  const rows = steps
    .map(
      ([title, done, detail, href, label], i) =>
        `<section class="section" data-onboarding-step="${i + 1}" data-complete="${done}" data-state="${done ? 'done' : signedReleasePending && i === 3 ? 'blocked' : 'pending'}"><div class="section-header"><div><h2 class="section-title">${i + 1}. ${escapeHtml(title)}</h2><p class="section-subtitle">${escapeHtml(detail)}</p></div><span data-step-status class="badge ${done ? 'badge-ok' : signedReleasePending && i === 3 ? 'badge-danger' : 'badge-off'}">${done ? 'Complete' : signedReleasePending && i === 3 ? 'Blocked' : next === i + 1 ? 'Next' : 'Pending'}</span></div><div class="section-body">${i >= 3 && !ready ? '<span class="muted">Available after database setup.</span>' : `<a class="btn" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`}${i === 5 ? localHelp : ''}</div></section>`,
    )
    .join('');
  // No server-side API proves that a call originated in ChatGPT. Never set an
  // overall READY/DONE state from a healthcheck, Worker status, or generic OAuth audit.
  const summary = signedReleasePending
    ? 'Blocked: signed Worker release not approved'
    : !ready
      ? 'Next step: 2'
      : !endpointReady
        ? 'Blocked: verify secure MCP endpoint configuration'
        : next
          ? 'Next step: ' + next
          : 'Local checks complete; ChatGPT connection still needs external verification';
  const body = `${pageHeader('Getting Started', 'Six short steps backed by configuration and audit evidence. No OAuth, shell grant or external connection is automatic.', '<a class="btn" href="/admin/onboarding">Refresh status</a>')}
  <section class="section" data-onboarding-status="${signedReleasePending || (ready && !endpointReady) ? 'blocked' : 'pending'}" data-chatgpt-verification="unverified"><div class="section-body"><strong data-onboarding-summary>${escapeHtml(summary)}</strong><p class="muted">Canonical MCP endpoint (not an external connectivity check):</p><div class="copy-row"><code id="quickstart-mcp-url" style="flex:1">${mode === 'unsafe' ? 'Invalid or unsafe configuration' : escapeHtml(baseUrl) + '/mcp'}</code><button class="btn btn-sm" type="button" data-copy-target="quickstart-mcp-url" ${!endpointReady ? 'disabled' : ''}>${icon('copy')} Copy endpoint</button></div><p id="quickstart-endpoint-check" role="status">OAuth discovery has not yet been checked. HTTPS configuration alone does not prove external reachability.</p><p>Database, Worker connection and authenticated audit events are separate facts. A health check, online Worker or successful MCP audit cannot prove signed installer approval or ChatGPT connection.</p></div></section>
  <div class="stack">${rows}</div>
  <section class="section" id="chatgpt-connection"><div class="section-header"><div><h2 class="section-title">Connect ChatGPT (manual)</h2><p class="section-subtitle">Not automatically verified; an OAuth client or audit row is not a ChatGPT connection.</p></div><span class="badge badge-off">Manual verification</span></div><div class="section-body"><ol><li>In ChatGPT, open the setting for adding an MCP connector or app, and use the HTTPS endpoint copied above.</li><li>Copy the exact callback URI shown there into the OAuth client form. Keep the one-time client secret private.</li><li>Choose Connect and explicitly approve the displayed OAuth scopes; keep Read only for runtime_info; Worker execution and offline access require separate explicit consent.</li><li>Ask ChatGPT to call <code>runtime_info</code>, then refresh this wizard to verify the authenticated audit record. Check the connection in ChatGPT itself, as audit logs do not identify the UI that issued a call.</li></ol>${mode === 'local' ? '<p class="hint">A loopback endpoint cannot be reached by remote ChatGPT. Configure a trusted HTTPS public origin first.</p>' : ''}</div></section>
  ${signedReleasePending ? '<section class="section" data-worker-installer-probe="/worker/install.sh"><div class="section-body"><strong>Signed Worker installer</strong><p data-worker-installer-message role="status">Blocked by the signed-release gate (HTTP 503 expected). Checking the endpoint without executing any installer.</p></div></section>' : ''}`;
  return shell('Getting Started — mcp_worker', body, {
    admin: true,
    active: 'onboarding',
    csrfToken,
    breadcrumb: 'Getting Started',
  });
}

function secretModal(secret: PageSecret | null) {
  if (!secret) return '';
  return `<div id="secret-modal" class="modal-backdrop" data-auto-open="true" data-static="true" aria-hidden="true"><div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="secret-modal-title" aria-describedby="secret-modal-description"><div class="modal-header"><h2 id="secret-modal-title">Client secret created</h2><p id="secret-modal-description">Copy this secret now. It will not be shown again.</p></div><div class="modal-body"><div class="secret-warning">${icon('shield')}<div>Only the SHA-256 hash is persisted. Store the secret in your client configuration before closing.</div></div><div class="field"><span class="field-label">Client ID</span><div class="copy-row"><div id="new-client-id" class="secret-box" style="flex:1">${escapeHtml(secret.clientId)}</div><button class="btn btn-icon" type="button" data-copy-target="new-client-id" aria-label="Copy Client ID">${icon('copy')}</button></div></div><div class="field" style="margin-top:14px"><span class="field-label">Client Secret</span><div class="copy-row"><div id="new-client-secret" class="secret-box" style="flex:1">${escapeHtml(secret.clientSecret)}</div><button class="btn btn-icon" type="button" data-copy-target="new-client-secret" aria-label="Copy Client Secret">${icon('copy')}</button></div></div></div><div class="modal-footer"><button class="btn btn-primary" type="button" data-modal-close>I've saved the secret</button></div></div></div>`;
}

function oauthClientCreateModal({
  id,
  action,
  csrfToken,
  mcpUrl,
  personal = false,
  firstCall = '',
}: {
  id: string;
  action: string;
  csrfToken: string;
  mcpUrl: string;
  personal?: boolean;
  firstCall?: string;
}) {
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const nameId = `${id}-name`;
  const redirectId = `${id}-redirect`;
  const mcpId = `${id}-mcp-url`;
  const access = personal
    ? `<div class="field full"><span class="field-label">Access scopes</span><div class="migration-note"><strong>Read access</strong><span><code>mcp_worker.read</code> is always included. Enable additional permissions only when needed.</span></div><div class="scope-options"><label class="scope-option"><input type="checkbox" name="scopes" value="mcp_worker.terminal"><span><strong>Worker execution</strong><small>Permit file, Git, process and execution tools on your Workers.</small></span></label><label class="scope-option"><input type="checkbox" name="scopes" value="offline_access"><span><strong>Offline access</strong><small>Allow refresh tokens for persistent connections.</small></span></label></div></div>`
    : `<div class="field full"><span class="field-label">Access scopes</span><div class="scope-options"><label class="scope-option"><input type="checkbox" name="scopes" value="mcp_worker.read" checked><span><strong>Read</strong><small>Inspect runtime, repository and workspace state.</small></span></label><label class="scope-option"><input type="checkbox" name="scopes" value="mcp_worker.terminal"><span><strong>Worker execution</strong><small>Allow MCP file, Git, process and execution tools on enrolled Workers.</small></span></label><label class="scope-option"><input type="checkbox" name="scopes" value="offline_access"><span><strong>Offline access</strong><small>Allow refresh tokens for persistent connectors.</small></span></label></div></div>`;
  const identity = personal
    ? `<div class="migration-note"><strong>Personal identity</strong><span>This client is automatically bound to your existing user Principal ID and Profile ID.</span></div>`
    : `<div class="migration-note"><strong>Automatic identity</strong><span>Principal ID is generated by mcp_worker from the new Client ID after creation. It is immutable and cannot be entered manually.</span></div>`;
  return `<div id="${escapeHtml(id)}" class="modal-backdrop" aria-hidden="true"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(titleId)}" aria-describedby="${escapeHtml(descriptionId)}"><div class="modal-header"><h2 id="${escapeHtml(titleId)}">New OAuth Client</h2><p id="${escapeHtml(descriptionId)}">${personal ? 'Create a client bound to your personal mcp_worker identity.' : 'Create an application identity allowed to connect to mcp_worker.'}</p></div><form method="post" action="${escapeHtml(action)}" data-disable-on-submit><div class="modal-body"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><div class="form-grid"><div class="field full"><label for="${escapeHtml(nameId)}">Display name</label><input id="${escapeHtml(nameId)}" name="display_name" value="${firstCall === '1' ? 'ChatGPT' : firstCall === 'local' ? 'Local first MCP call' : ''}" required maxlength="120" placeholder="ChatGPT"></div><div class="field full"><label for="${escapeHtml(redirectId)}">Redirect URI(s)</label><textarea id="${escapeHtml(redirectId)}" name="redirect_uris" required placeholder="https://chatgpt.com/connector_platform_oauth_redirect">${firstCall === 'local' ? 'http://127.0.0.1:43871/callback' : firstCall === '1' ? 'https://chatgpt.com/connector_platform_oauth_redirect' : ''}</textarea><div class="hint">Use the exact callback from ChatGPT; replace the suggested URI if ChatGPT shows a different one. One HTTPS URI per line. localhost is allowed only for local development.</div></div><div class="field full"><span class="field-label">MCP URL</span><div class="copy-row"><code id="${escapeHtml(mcpId)}" style="flex:1">${escapeHtml(mcpUrl)}</code><button class="btn btn-icon" type="button" data-copy-target="${escapeHtml(mcpId)}" aria-label="Copy MCP URL">${icon('copy')}</button></div><div class="hint">Use this URL when adding mcp_worker as an MCP connector.</div></div>${access}<div class="field full">${identity}</div></div></div><div class="modal-footer"><button class="btn" type="button" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Create Client</button></div></form></div></div>`;
}

function telegramConfigurationModal({
  id,
  action,
  csrfToken,
  config,
  description,
}: {
  id: string;
  action: string;
  csrfToken: string;
  config: PageTelegram;
  description: string;
}) {
  const titleId = `${id}-title`;
  return `<div id="${escapeHtml(id)}" class="modal-backdrop" aria-hidden="true"><div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(titleId)}"><div class="modal-header"><h2 id="${escapeHtml(titleId)}">Edit Telegram Configuration</h2><p>${escapeHtml(description)}</p></div><form method="post" action="${escapeHtml(action)}" data-disable-on-submit><div class="modal-body"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><div class="stack"><div class="field"><span class="field-label">Status</span><label class="switch-row" for="${escapeHtml(id)}-enabled"><span><strong>Enabled</strong><span class="hint">Allow this mcp_worker context to send Telegram messages.</span></span><input id="${escapeHtml(id)}-enabled" name="enabled" type="checkbox" value="true" ${config.enabled ? 'checked' : ''}><span class="switch-control" aria-hidden="true"></span></label></div><div class="field"><label for="${escapeHtml(id)}-token">Bot Token</label><input id="${escapeHtml(id)}-token" type="password" name="bot_token" autocomplete="new-password" placeholder="${config.hasToken ? 'Stored securely — leave blank to keep current token' : 'Enter Telegram Bot Token'}"><div class="hint">Existing tokens are never rendered back to the browser.</div></div><div class="field"><label for="${escapeHtml(id)}-chat">Chat ID</label><input id="${escapeHtml(id)}-chat" name="chat_id" value="${escapeHtml(config.chatId || '')}" maxlength="128" placeholder="123456789"></div></div></div><div class="modal-footer"><button class="btn" type="button" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Save Changes</button></div></form></div></div>`;
}

function telegramSummary({
  title,
  subtitle,
  config,
  csrfToken,
  editModalId,
  testAction,
  secondaryTitle,
  secondarySubtitle,
  secondaryRows,
  editDisabled = '',
}: {
  title: string;
  subtitle: string;
  config: PageTelegram;
  csrfToken: string;
  editModalId: string;
  testAction: string;
  secondaryTitle: string;
  secondarySubtitle: string;
  secondaryRows: string;
  editDisabled?: string;
}) {
  const configured = Boolean(config?.hasToken && config?.chatId);
  return `<div class="grid-2"><section class="section"><div class="section-header"><div><h2 class="section-title">${escapeHtml(title)}</h2><p class="section-subtitle">${escapeHtml(subtitle)}</p></div><span class="badge ${configured && config.enabled ? 'badge-ok' : 'badge-off'}">${configured && config.enabled ? 'Configured' : configured ? 'Disabled' : 'Not configured'}</span></div><div class="section-body"><div class="status-list"><div class="status-row"><div><div class="status-row-title">Status</div><div class="status-row-sub">Whether Telegram delivery is enabled</div></div><strong>${config.enabled ? 'Enabled' : 'Disabled'}</strong></div><div class="status-row"><div><div class="status-row-title">Bot Token</div><div class="status-row-sub">AES-256-GCM encrypted at rest</div></div><strong>${config.hasToken ? 'Stored securely' : 'Not configured'}</strong></div><div class="status-row"><div><div class="status-row-title">Chat ID</div><div class="status-row-sub">Target Telegram conversation</div></div><span class="mono">${escapeHtml(config.chatId || 'Not configured')}</span></div></div><div class="settings-actions"><button class="btn" type="button" data-modal-open="${escapeHtml(editModalId)}"${editDisabled}>${icon('pencil')} Edit Configuration</button><form method="post" action="${escapeHtml(testAction)}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="btn" type="submit" ${!configured ? 'disabled' : ''}>${icon('send')} Send Test Message</button></form></div></div></section><section class="section"><div class="section-header"><div><h2 class="section-title">${escapeHtml(secondaryTitle)}</h2><p class="section-subtitle">${escapeHtml(secondarySubtitle)}</p></div>${icon('shield')}</div><div class="section-body"><div class="status-list">${secondaryRows}</div></div></section></div>`;
}

function clientsPage({
  clients,
  mcpUrl = '/mcp',
  csrfToken,
  secret = null,
  success = '',
  error = '',
  firstCall = '',
}: {
  clients: PageClient[];
  mcpUrl?: string;
  csrfToken: string;
  secret?: PageSecret | null;
  success?: string;
  error?: string;
  firstCall?: string;
}) {
  const rows = clients
    .map((c) => {
      const statusClass =
        c.status === 'active' ? 'badge-ok' : c.status === 'revoked' ? 'badge-danger' : 'badge-off';
      const last = c.last_authorized_at
        ? new Date(c.last_authorized_at).toLocaleString('en-GB')
        : 'Never';
      const search = [
        c.display_name,
        c.client_id,
        c.principal_id,
        c.status,
        ...c.allowed_scopes,
        ...c.redirect_uris,
      ].join(' ');
      return `<tr data-search="${escapeHtml(search)}"><td data-label="Client"><div class="cell-title">${escapeHtml(c.display_name)}</div><div class="cell-sub mono">${escapeHtml(c.client_id)}</div></td><td data-label="Principal"><span class="mono">${escapeHtml(c.principal_id)}</span></td><td data-label="Status"><span class="badge ${statusClass}">${escapeHtml(c.status)}</span></td><td data-label="Scopes">${c.allowed_scopes.map((s) => `<span class="code-chip">${escapeHtml(s)}</span>`).join('')}</td><td data-label="Last Authorized">${escapeHtml(last)}</td><td data-label="Actions" style="text-align:right"><details class="dropdown"><summary class="btn btn-icon btn-ghost" role="button" aria-haspopup="menu" aria-label="Actions for ${escapeHtml(c.display_name)}">${icon('more')}</summary><div class="menu" role="menu" aria-label="Actions for ${escapeHtml(c.display_name)}"><button type="button" role="menuitem" data-copy-value="${escapeHtml(c.client_id)}">${icon('copy')} Copy Client ID</button><a role="menuitem" href="/admin/audit?client_id=${encodeURIComponent(c.client_id)}">${icon('history')} View Activity</a><form method="post" action="/admin/clients/${escapeHtml(c.id)}/rotate" data-confirm-title="Rotate client secret?" data-confirm-message="The current secret will immediately stop working." data-confirm-action="Rotate Secret"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" role="menuitem">${icon('refresh')} Rotate Secret</button></form>${c.status === 'active' ? `<form method="post" action="/admin/clients/${escapeHtml(c.id)}/disable" data-confirm-title="Disable OAuth client?" data-confirm-message="New authorization attempts will be blocked until this client is enabled again." data-confirm-action="Disable"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" role="menuitem">${icon('power')} Disable</button></form>` : `<form method="post" action="/admin/clients/${escapeHtml(c.id)}/enable"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" role="menuitem">${icon('power')} Enable</button></form>`}<form method="post" action="/admin/clients/${escapeHtml(c.id)}/revoke" data-confirm-title="Revoke client tokens?" data-confirm-message="All issued tokens for this client will stop working." data-confirm-action="Revoke Tokens" data-confirm-danger="true"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="danger" type="submit" role="menuitem">${icon('shield')} Revoke Tokens</button></form><div class="menu-separator"></div><form method="post" action="/admin/clients/${escapeHtml(c.id)}/delete" data-confirm-title="Delete OAuth client?" data-confirm-message="This removes the client and revokes its tokens. This cannot be undone." data-confirm-action="Delete Client" data-confirm-danger="true"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="danger" type="submit" role="menuitem">${icon('trash')} Delete Client</button></form></div></details></td></tr>`;
    })
    .join('');
  const createModal = oauthClientCreateModal({
    id: 'client-create-modal',
    action: '/admin/clients',
    csrfToken,
    mcpUrl,
    personal: false,
    firstCall,
  });
  const body = `${flashData(success, error)}${pageHeader('OAuth Clients', 'Manage applications authorized to connect to mcp_worker.', `<button class="btn btn-primary" type="button" data-modal-open="client-create-modal">${icon('plus')} New Client</button>`)}<div class="toolbar"><div class="search">${icon('search')}<input class="input" type="search" aria-label="Search OAuth clients" data-table-search="clients-table" placeholder="Search clients..."></div></div><section class="section">${clients.length ? `<div class="table-wrap"><table id="clients-table" class="table"><thead><tr><th>Client</th><th>Principal</th><th>Status</th><th>Scopes</th><th>Last Authorized</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="search-empty" data-search-empty="clients-table" hidden>No matching OAuth clients.</div>` : `<div class="empty"><div class="empty-icon">${icon('key')}</div><strong>No OAuth clients yet</strong><div>Create a client to connect ChatGPT or another MCP consumer.</div><br><button class="btn btn-primary" type="button" data-modal-open="client-create-modal">${icon('plus')} New Client</button></div>`}</section>${createModal}${secretModal(secret)}`;
  return shell('OAuth Clients — mcp_worker', body, {
    admin: true,
    active: 'clients',
    csrfToken,
    breadcrumb: 'OAuth Clients',
  });
}

function auditPage({
  logs,
  clients,
  toolNames,
  filters,
  page,
  perPage,
  total,
  totalPages,
  csrfToken,
}: {
  logs: PageAudit[];
  clients: PageClient[];
  toolNames: string[];
  filters: PageFilters;
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  csrfToken: string;
}) {
  const selected = (value: string, expected: string) => (value === expected ? ' selected' : '');
  const rows = logs
    .map((log) => {
      const resultClass = log.result === 'SUCCESS' ? 'badge-ok' : 'badge-danger';
      const clientName = log.client_display_name || log.client_id || 'Unknown client';
      const clientId = log.client_id || '—';
      const createdAt = log.created_at ? new Date(log.created_at).toLocaleString('en-GB') : '—';
      const truncated = Boolean(log.request_truncated || log.response_truncated);
      return `<tr><td data-label="Time"><div class="cell-title">${escapeHtml(createdAt)}</div><div class="cell-sub mono">${escapeHtml(log.request_id)}</div></td><td data-label="Client"><div class="cell-title">${escapeHtml(clientName)}</div><div class="cell-sub mono">${escapeHtml(clientId)}</div></td><td data-label="MCP Method"><span class="code-chip">${escapeHtml(log.mcp_method)}</span></td><td data-label="Tool">${log.tool_name ? `<span class="mono">${escapeHtml(log.tool_name)}</span>` : '<span class="muted">—</span>'}</td><td data-label="Result"><span class="badge ${resultClass}">${escapeHtml(log.result)}</span></td><td data-label="HTTP">${escapeHtml(log.http_status)}</td><td data-label="Duration"><span class="mono">${escapeHtml(log.duration_ms)} ms</span></td><td data-label="Details"><button class="btn btn-sm" type="button" data-audit-detail="${escapeHtml(log.id)}" data-modal-open="audit-detail-modal">View${truncated ? ' · preview' : ''}</button></td></tr>`;
    })
    .join('');

  const pageHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (filters.query) params.set('q', filters.query);
    if (filters.clientId) params.set('client_id', filters.clientId);
    if (filters.toolName) params.set('tool_name', filters.toolName);
    if (filters.result) params.set('result', filters.result);
    params.set('per_page', String(perPage));
    if (targetPage > 1) params.set('page', String(targetPage));
    return `/admin/audit?${params.toString()}`;
  };

  const pageItems: Array<number | '…'> = [];
  if (totalPages <= 7) {
    for (let value = 1; value <= totalPages; value += 1) pageItems.push(value);
  } else {
    const values = [
      ...new Set(
        [1, 2, page - 1, page, page + 1, totalPages - 1, totalPages].filter(
          (value) => value >= 1 && value <= totalPages,
        ),
      ),
    ].sort((a, b) => a - b);
    let previous = 0;
    for (const value of values) {
      if (previous && value - previous > 1) pageItems.push('…');
      pageItems.push(value);
      previous = value;
    }
  }

  const start = total ? (page - 1) * perPage + 1 : 0;
  const end = Math.min(page * perPage, total);
  const hiddenFilters = `${filters.query ? `<input type="hidden" name="q" value="${escapeHtml(filters.query)}">` : ''}${filters.clientId ? `<input type="hidden" name="client_id" value="${escapeHtml(filters.clientId)}">` : ''}${filters.toolName ? `<input type="hidden" name="tool_name" value="${escapeHtml(filters.toolName)}">` : ''}${filters.result ? `<input type="hidden" name="result" value="${escapeHtml(filters.result)}">` : ''}`;
  const pageSize = `<form class="audit-page-size" method="get" action="/admin/audit" data-page-size-form>${hiddenFilters}<label for="audit-page-size">Rows</label><select id="audit-page-size" class="input" name="per_page" data-page-size><option value="20"${selected(String(perPage), '20')}>20</option><option value="50"${selected(String(perPage), '50')}>50</option><option value="100"${selected(String(perPage), '100')}>100</option></select></form>`;
  const numberLinks = pageItems
    .map((item) =>
      item === '…'
        ? '<span class="page-ellipsis" aria-hidden="true">…</span>'
        : `<a class="page-btn${item === page ? ' active' : ''}" href="${escapeHtml(pageHref(item))}" ${item === page ? 'aria-current="page"' : ''}>${item}</a>`,
    )
    .join('');
  const pager = `<div class="audit-pagination"><div class="audit-pagination-meta"><span>Showing <strong>${start}–${end}</strong> of <strong>${escapeHtml(total)}</strong></span>${pageSize}</div><nav class="page-nav" aria-label="Audit log pagination">${page > 1 ? `<a class="page-btn page-arrow" href="${escapeHtml(pageHref(page - 1))}" aria-label="Previous page">‹</a>` : '<span class="page-btn page-arrow disabled" aria-hidden="true">‹</span>'}${numberLinks}${page < totalPages ? `<a class="page-btn page-arrow" href="${escapeHtml(pageHref(page + 1))}" aria-label="Next page">›</a>` : '<span class="page-btn page-arrow disabled" aria-hidden="true">›</span>'}</nav></div>`;

  const clientOptions = clients
    .map(
      (client) =>
        `<option value="${escapeHtml(client.client_id)}"${selected(filters.clientId, client.client_id)}>${escapeHtml(client.display_name)} · ${escapeHtml(client.client_id)}</option>`,
    )
    .join('');
  const toolOptions = toolNames
    .map(
      (tool) =>
        `<option value="${escapeHtml(tool)}"${selected(filters.toolName, tool)}>${escapeHtml(tool)}</option>`,
    )
    .join('');
  const filtersForm = `<form class="audit-filters" method="get" action="/admin/audit"><input type="hidden" name="per_page" value="${escapeHtml(perPage)}"><div class="search audit-search">${icon('search')}<input class="input" type="search" name="q" value="${escapeHtml(filters.query)}" aria-label="Search audit log" placeholder="Request, client, method or tool..."></div><select class="input" name="client_id" aria-label="Filter by client"><option value="">All clients</option>${clientOptions}</select><select class="input" name="tool_name" aria-label="Filter by tool"><option value="">All tools</option>${toolOptions}</select><select class="input" name="result" aria-label="Filter by result"><option value="">All results</option><option value="SUCCESS"${selected(filters.result, 'SUCCESS')}>Success</option><option value="DENIED"${selected(filters.result, 'DENIED')}>Denied</option><option value="ERROR"${selected(filters.result, 'ERROR')}>Error</option></select><button class="btn btn-primary" type="submit">Apply</button><a class="btn" href="/admin/audit?per_page=${escapeHtml(perPage)}">Clear</a></form>`;
  const detailModal = `<div id="audit-detail-modal" class="modal-backdrop" aria-hidden="true"><div class="modal audit-detail-modal" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title" aria-describedby="audit-detail-description"><div class="modal-header"><h2 id="audit-detail-title">Audit Event Detail</h2><p id="audit-detail-description">Sanitized MCP request and response payload captured for this call.</p></div><div class="modal-body"><div class="audit-detail-meta"><div><span>Request ID</span><strong id="audit-detail-request-id" class="mono">—</strong></div><div><span>Client</span><strong id="audit-detail-client">—</strong></div><div><span>Method</span><strong id="audit-detail-method" class="mono">—</strong></div><div><span>Tool</span><strong id="audit-detail-tool" class="mono">—</strong></div><div><span>Result</span><strong id="audit-detail-result">—</strong></div><div><span>HTTP / Duration</span><strong id="audit-detail-http">—</strong></div></div><div class="audit-payload-grid"><section class="audit-payload-card"><div class="audit-payload-head"><div><h3>Request</h3><p>JSON-RPC input / tool arguments</p></div><button class="btn btn-sm" type="button" data-copy-target="audit-request-payload">Copy</button></div><pre id="audit-request-payload" class="audit-json">Select an event to load its request.</pre><div id="audit-request-note" class="audit-capture-note" hidden>Only the captured preview is stored because this request exceeded the audit size limit.</div></section><section class="audit-payload-card"><div class="audit-payload-head"><div><h3>Response</h3><p>MCP result / error returned to the client</p></div><button class="btn btn-sm" type="button" data-copy-target="audit-response-payload">Copy</button></div><pre id="audit-response-payload" class="audit-json">Select an event to load its response.</pre><div id="audit-response-note" class="audit-capture-note" hidden>Only the captured preview is stored because this response exceeded the audit size limit.</div></section></div><div class="audit-security-note">Sensitive fields such as tokens, passwords, secrets, authorization headers and cookies are redacted before storage.</div></div><div class="modal-footer"><button class="btn" type="button" data-modal-close>Close</button></div></div></div>`;
  const body = `${pageHeader('Audit Log', 'Trace each MCP call and inspect the sanitized request arguments and response payload.', `<span class="badge badge-off">${escapeHtml(total)} events</span>`)}${filtersForm}<section class="section audit-section">${logs.length ? `<div class="table-wrap"><table id="audit-table" class="table audit-table"><thead><tr><th>Time / Request</th><th>Client</th><th>MCP Method</th><th>Tool</th><th>Result</th><th>HTTP</th><th>Duration</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><div class="empty-icon">${icon('history')}</div><strong>No audit events found</strong><div>Connected MCP client activity will appear here automatically.</div></div>`}${pager}</section>${detailModal}`;
  return shell('Audit Log — mcp_worker', body, {
    admin: true,
    active: 'audit',
    csrfToken,
    breadcrumb: 'Audit Log',
  });
}

function telegramPage({
  config,
  csrfToken,
  success = '',
  error = '',
}: {
  config: PageTelegram;
  csrfToken: string;
  success?: string;
  error?: string;
}) {
  const configured = config.hasToken && Boolean(config.chatId);
  const modal = `<div id="telegram-modal" class="modal-backdrop" aria-hidden="true"><div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="telegram-modal-title" aria-describedby="telegram-modal-description"><div class="modal-header"><h2 id="telegram-modal-title">Edit Telegram Configuration</h2><p id="telegram-modal-description">Configure the optional Telegram support channel for mcp_worker.</p></div><form method="post" action="/admin/telegram" data-disable-on-submit><div class="modal-body"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><div class="stack"><div class="field"><span class="field-label">Status</span><label class="switch-row" for="telegram-enabled"><span><strong>Enabled</strong><span class="hint">Allow mcp_worker to send Telegram messages.</span></span><input id="telegram-enabled" name="enabled" type="checkbox" value="true" ${config.enabled ? 'checked' : ''}><span class="switch-control" aria-hidden="true"></span></label></div><div class="field"><label for="telegram-bot-token">Bot Token</label><input id="telegram-bot-token" type="password" name="bot_token" autocomplete="new-password" placeholder="${config.hasToken ? 'Stored securely — leave blank to keep current token' : 'Enter Telegram Bot Token'}"><div class="hint">Existing tokens are never rendered back to the browser.</div></div><div class="field"><label for="telegram-chat-id">Chat ID</label><input id="telegram-chat-id" name="chat_id" value="${escapeHtml(config.chatId || '')}" maxlength="128" placeholder="123456789"></div></div></div><div class="modal-footer"><button class="btn" type="button" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Save Changes</button></div></form></div></div>`;
  const body = `${flashData(success, error)}${pageHeader('Telegram', 'Configure optional Telegram notifications for mcp_worker.', `<button class="btn btn-primary" type="button" data-modal-open="telegram-modal">${icon('pencil')} Edit Configuration</button>`)}<div class="grid-2"><section class="section"><div class="section-header"><div><h2 class="section-title">Telegram MCP</h2><p class="section-subtitle">Support notification channel</p></div><span class="badge ${configured && config.enabled ? 'badge-ok' : 'badge-off'}">${configured && config.enabled ? 'Configured' : configured ? 'Disabled' : 'Not configured'}</span></div><div class="section-body"><div class="status-list"><div class="status-row"><div><div class="status-row-title">Status</div><div class="status-row-sub">Whether Telegram delivery is enabled</div></div><strong>${config.enabled ? 'Enabled' : 'Disabled'}</strong></div><div class="status-row"><div><div class="status-row-title">Bot Token</div><div class="status-row-sub">Encrypted with AES-256-GCM at rest</div></div><strong>${config.hasToken ? 'Stored securely' : 'Not configured'}</strong></div><div class="status-row"><div><div class="status-row-title">Chat ID</div><div class="status-row-sub">Target conversation for test/support messages</div></div><span class="mono">${escapeHtml(config.chatId || 'Not configured')}</span></div></div><div style="display:flex;gap:8px;margin-top:18px"><button class="btn" type="button" data-modal-open="telegram-modal">${icon('pencil')} Edit Configuration</button><form method="post" action="/admin/telegram/test"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="btn" type="submit" ${!configured ? 'disabled' : ''}>${icon('send')} Send Test Message</button></form></div></div></section><section class="section"><div class="section-header"><div><h2 class="section-title">Security</h2><p class="section-subtitle">How mcp_worker handles Telegram credentials.</p></div>${icon('shield')}</div><div class="section-body"><p class="muted">Telegram operational settings are stored in the database. Bot tokens are encrypted before storage and are never displayed again after save.</p><div class="status-list"><div class="status-row"><div><div class="status-row-title">Configuration source</div><div class="status-row-sub">Enabled state, Chat ID, and encrypted Bot Token</div></div><span class="badge badge-ok">Database</span></div><div class="status-row"><div><div class="status-row-title">Encryption</div><div class="status-row-sub">AES-256-GCM using the application credential key</div></div><span class="badge badge-ok">Enabled</span></div><div class="status-row"><div><div class="status-row-title">Runtime role</div><div class="status-row-sub">Optional support only; no Control Plane or worker runtime</div></div><span class="badge badge-off">Support only</span></div></div></div></section></div>${modal}`;
  return shell('Telegram — mcp_worker', body, {
    admin: true,
    active: 'telegram',
    csrfToken,
    breadcrumb: 'Telegram',
  });
}

function trustedWorkerHttpsOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && parsed.origin === origin;
  } catch {
    return false;
  }
}

// Keep installer download failure observable: "curl | sh" can exit 0 on a failed curl.
function workerInstallCommand(origin: string, platform: 'linux' | 'macos' | 'windows') {
  if (!trustedWorkerHttpsOrigin(origin)) throw new Error('Trusted HTTPS Worker origin required.');
  const url = `${origin}/worker/install${platform === 'windows' ? '.ps1' : `-${platform}.sh`}`;
  if (platform === 'windows')
    return `& { $ErrorActionPreference = 'Stop'; $script = Invoke-RestMethod -Uri '${url}' -MaximumRedirection 0; if ([string]::IsNullOrWhiteSpace($script)) { throw 'Empty Worker installer' }; Invoke-Expression $script }`;
  return String.raw`sh -c 'f=$(mktemp) || exit 1; trap "rm -f \"$f\"" EXIT; curl -fsSL --max-redirs 0 --proto "=https" "${url}" -o "$f" && test -s "$f" && sh "$f"'`;
}

function workersPage({
  workers = [],
  profiles = [],
  enrollment = null,
  workerInstallUrl = '/worker/install.sh',
  routeBase = '/admin/workers',
  accountUser = null,
  csrfToken,
  success = '',
  error = '',
  checkingWorkerId = '',
}: {
  workers?: PageWorker[];
  profiles?: PageProfile[];
  enrollment?: { expires_at?: string; token: string } | null;
  workerInstallUrl?: string;
  routeBase?: string;
  accountUser?: PageUser | null;
  csrfToken: string;
  success?: string;
  error?: string;
  checkingWorkerId?: string;
}) {
  const signedReleaseApproved =
    workerSignedReleaseReadiness().productionDistributionApproved && !workerDistributionBlocked();
  const onlineCount = workers.filter(
    (worker) => worker.enabled && worker.status === 'online',
  ).length;
  const disabledCount = workers.filter((worker) => !worker.enabled).length;
  const offlineCount = Math.max(0, workers.length - onlineCount - disabledCount);
  const profileCountByWorker = new Map<string, number>();
  for (const profile of profiles)
    profileCountByWorker.set(
      profile.worker_id,
      (profileCountByWorker.get(profile.worker_id) || 0) + 1,
    );

  const workerRows = workers
    .map((worker) => {
      const online = worker.enabled && worker.status === 'online';
      const statusLabel = worker.enabled ? (online ? 'Online' : 'Offline') : 'Disabled';
      const statusClass = online ? 'badge-ok' : 'badge-off';
      const capabilityItems = worker.capabilities || [];
      const visibleCapabilities = capabilityItems
        .slice(0, 2)
        .map((item) => `<span class="code-chip">${escapeHtml(item)}</span>`)
        .join('');
      const remainingCapabilities = Math.max(0, capabilityItems.length - 2);
      const capabilities = capabilityItems.length
        ? `${visibleCapabilities}${remainingCapabilities ? `<span class="code-chip">+${remainingCapabilities}</span>` : ''}`
        : '<span class="muted">None</span>';
      const action = worker.enabled ? 'disable' : 'enable';
      const ownerLabel = worker.owner_user_id
        ? worker.owner_display_name || worker.owner_username || worker.owner_user_id
        : 'Admin / global';
      const searchBase = [worker.name, worker.id, ownerLabel, ...(worker.capabilities || [])].join(
        ' ',
      );
      const search = `${searchBase} ${statusLabel}`;
      const profileCount = profileCountByWorker.get(worker.id) || 0;
      const editPayload = escapeHtml(JSON.stringify({ id: worker.id, name: worker.name }));
      return `<tr data-worker-id="${escapeHtml(worker.id)}" data-worker-search-base="${escapeHtml(searchBase)}" data-search="${escapeHtml(search)}"><td data-label="Worker"><div class="cell-title">${escapeHtml(worker.name)}</div><div class="cell-sub mono">${escapeHtml(worker.id)}</div></td>${accountUser ? '' : `<td data-label="Owner"><div class="cell-title">${escapeHtml(ownerLabel)}</div><div class="cell-sub">${worker.owner_user_id ? 'User-owned' : 'Administrator'}</div></td>`}<td data-label="Connection"><span data-worker-connection class="badge ${statusClass}">${statusLabel}</span></td><td data-label="Profiles"><strong>${profileCount}</strong></td><td data-label="Last Seen"><span data-worker-last-seen>${escapeHtml(worker.last_seen_at ? new Date(worker.last_seen_at).toLocaleString('en-GB') : 'Never')}</span></td><td data-label="Capabilities">${capabilities}</td><td data-label="Actions" style="text-align:right"><details class="dropdown"><summary class="btn btn-icon btn-ghost" role="button" aria-haspopup="menu" aria-label="Actions for ${escapeHtml(worker.name)}">${icon('more')}</summary><div class="menu" role="menu" aria-label="Actions for ${escapeHtml(worker.name)}"><button type="button" role="menuitem" data-worker-edit="${editPayload}" data-worker-route-base="${escapeHtml(routeBase)}" data-modal-open="worker-edit-modal">${icon('pencil')} Edit name</button><form method="post" action="${escapeHtml(routeBase)}/${escapeHtml(worker.id)}/${action}" ${worker.enabled ? 'data-confirm-title="Disable Worker?" data-confirm-message="The current worker connection will be terminated and future handshakes will be rejected until re-enabled." data-confirm-action="Disable Worker"' : ''}><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" role="menuitem">${icon('power')} ${worker.enabled ? 'Disable' : 'Enable'}</button></form><div class="menu-separator"></div><form method="post" action="${escapeHtml(routeBase)}/${escapeHtml(worker.id)}/remove" data-confirm-title="Remove Worker remotely?" data-confirm-message="This will uninstall mcp_worker Worker from the target machine, revoke its identity, and delete its Worker Profiles. The Worker must be online. This action cannot be undone." data-confirm-action="Remove Worker" data-confirm-danger="true"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="danger" type="submit" role="menuitem">${icon('trash')} Remove from mcp_worker</button></form><form method="post" action="${escapeHtml(routeBase)}/${escapeHtml(worker.id)}/force-remove" data-confirm-title="Force delete Worker?" data-confirm-message="This deletes the Worker identity and Worker Profiles from mcp_worker without waiting for remote uninstall. Local Worker files may remain on the target machine. Use this only when normal Remove cannot complete." data-confirm-action="Force Delete" data-confirm-danger="true"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="danger" type="submit" role="menuitem">${icon('trash')} Force delete</button></form></div></details></td></tr>`;
    })
    .join('');

  const profileRows = profiles
    .map((profile) => {
      const search = [
        profile.name,
        profile.description || '',
        profile.worker_name || profile.worker_id,
        profile.enabled ? 'enabled' : 'disabled',
      ].join(' ');
      return `<tr data-search="${escapeHtml(search)}"><td data-label="Profile"><div class="cell-title">${escapeHtml(profile.name)}</div><div class="cell-sub">${escapeHtml(profile.description || 'No description')}</div></td><td data-label="Worker"><span class="mono">${escapeHtml(profile.worker_name || profile.worker_id)}</span></td><td data-label="Status"><span class="badge ${profile.enabled ? 'badge-ok' : 'badge-off'}">${profile.enabled ? 'Enabled' : 'Disabled'}</span></td><td data-label="Actions" style="text-align:right"><form method="post" action="${escapeHtml(routeBase)}/profiles/${escapeHtml(profile.id)}/delete" data-confirm-title="Delete Worker Profile?" data-confirm-message="This removes the profile alias. The worker identity remains enrolled." data-confirm-action="Delete Profile" data-confirm-danger="true"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="btn btn-sm btn-ghost danger" type="submit">${icon('trash')} Delete</button></form></td></tr>`;
    })
    .join('');

  const onlineWorkers = workers.filter((worker) => worker.enabled && worker.status === 'online');
  const workerOptions = onlineWorkers
    .map((worker) => `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.name)}</option>`)
    .join('');
  const workerField =
    onlineWorkers.length === 1
      ? `<div class="field"><span class="field-label">Worker</span><div class="hint">Automatically using ${escapeHtml(onlineWorkers[0].name)} (the only online Worker).</div><input type="hidden" name="worker_id" value="${escapeHtml(onlineWorkers[0].id)}"></div>`
      : `<div class="field"><label for="worker-profile-worker">Worker</label><select id="worker-profile-worker" class="input" name="worker_id" required><option value="">Select online Worker</option>${workerOptions}</select></div>`;
  const profileModal = `<div id="worker-profile-modal" class="modal-backdrop" aria-hidden="true"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="worker-profile-title" aria-describedby="worker-profile-description"><div class="modal-header"><h2 id="worker-profile-title">New Worker Profile</h2><p id="worker-profile-description">Bind a stable MCP profile alias to an enrolled Worker shell.</p></div><form method="post" action="${escapeHtml(routeBase)}/profiles" data-disable-on-submit><div class="modal-body"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><div class="form-grid"><div class="field"><label for="worker-profile-name">Name</label><input id="worker-profile-name" name="name" required maxlength="100" placeholder="Dev Laptop"></div>${workerField}<div class="field full"><label for="worker-profile-description-input">Description</label><input id="worker-profile-description-input" name="description" maxlength="500" placeholder="Local development worker"></div><div class="field full"><span class="field-label">Status</span><label class="switch-row" for="worker-profile-enabled"><span><strong>Enabled</strong><span class="hint">Allow MCP tools and MCP calls to run through this Worker.</span></span><input id="worker-profile-enabled" name="enabled" type="checkbox" value="true" checked><span class="switch-control" aria-hidden="true"></span></label></div></div></div><div class="modal-footer"><button class="btn" type="button" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Create Profile</button></div></form></div></div>`;
  const workerEditModal = `<div id="worker-edit-modal" class="modal-backdrop" aria-hidden="true"><div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="worker-edit-title" aria-describedby="worker-edit-description"><div class="modal-header"><h2 id="worker-edit-title">Edit Worker name</h2><p id="worker-edit-description">Change the display name used in mcp_worker. Worker identity and profiles are not recreated.</p></div><form id="worker-edit-form" method="post" action="" data-disable-on-submit><div class="modal-body"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><div class="field"><label for="worker-edit-name">Worker name</label><input id="worker-edit-name" name="name" required maxlength="100" autocomplete="off"></div></div><div class="modal-footer"><button class="btn" type="button" data-modal-close>Cancel</button><button class="btn btn-primary" type="submit">Save name</button></div></form></div></div>`;
  const workerBaseUrl = workerInstallUrl.replace(/\/worker\/install\.sh$/, '');
  const workerBaseIsHttps = trustedWorkerHttpsOrigin(workerBaseUrl);
  const directInstallAvailable = signedReleaseApproved && workerBaseIsHttps;
  const linuxInstallCommand = directInstallAvailable ? workerInstallCommand(workerBaseUrl, 'linux') : '';
  const macInstallCommand = directInstallAvailable ? workerInstallCommand(workerBaseUrl, 'macos') : '';
  const windowsInstallCommand = directInstallAvailable ? workerInstallCommand(workerBaseUrl, 'windows') : '';
  const canEnroll = !accountUser || directInstallAvailable;
  const loginServer = workerBaseIsHttps ? workerBaseUrl : 'https://YOUR_MCP_DOMAIN';
  const devClone = 'git clone https://github.com/mathew15064/mcp_worker.git';
  const manualInstaller = `<details style="margin-top:14px"><summary>Developer fallback (advanced · reviewed source)</summary><div class="migration-note" style="margin-top:10px"><strong>Development installation — Go 1.24+</strong><span>Signed Worker downloads are not approved (HTTP 503). Build the Worker locally from reviewed source; do not run unverified install scripts.</span></div><div class="field" style="margin-top:14px"><span class="field-label">1. Build Worker on your machine</span><div class="stack" style="margin-top:8px"><div><div class="hint" style="margin-bottom:6px">Linux / macOS</div><div class="copy-row"><code id="worker-dev-unix-command" style="flex:1;white-space:pre-wrap">${escapeHtml(`${devClone}\ncd mcp_worker/worker-go\ngo build -trimpath -o worker_mcp .`)}</code><button class="btn btn-icon" type="button" data-copy-target="worker-dev-unix-command" aria-label="Copy Unix Go build commands">${icon('copy')}</button></div></div><div><div class="hint" style="margin-bottom:6px">Windows · PowerShell</div><div class="copy-row"><code id="worker-dev-win-command" style="flex:1;white-space:pre-wrap">${escapeHtml(`${devClone}\ncd mcp_worker/worker-go\ngo build -trimpath -o worker_mcp.exe .`)}</code><button class="btn btn-icon" type="button" data-copy-target="worker-dev-win-command" aria-label="Copy Windows Go build commands">${icon('copy')}</button></div></div></div></div></details>`;
  const unavailableInstaller = `<div class="migration-note" role="status"><strong>Signed one-command installation unavailable</strong><span>${signedReleaseApproved ? 'Configure a trusted HTTPS public base URL before distributing or connecting Workers. No HTTP installer command is offered.' : 'Owner approval of a signed Worker release is pending. Public installers return HTTP 503; do not run unapproved download commands.'}</span></div>${manualInstaller}`;
  const approvedInstaller = `<div class="field" style="margin-top:14px"><span class="field-label">1. Install Worker on your machine</span><div class="stack" style="margin-top:8px"><div><div class="hint" style="margin-bottom:6px">Linux</div><div class="copy-row"><code id="worker-install-linux-command" style="flex:1">${escapeHtml(linuxInstallCommand)}</code><button class="btn btn-icon" type="button" data-copy-target="worker-install-linux-command" aria-label="Copy Linux worker install command">${icon('copy')}</button></div></div><div><div class="hint" style="margin-bottom:6px">macOS · Intel or Apple Silicon</div><div class="copy-row"><code id="worker-install-macos-command" style="flex:1">${escapeHtml(macInstallCommand)}</code><button class="btn btn-icon" type="button" data-copy-target="worker-install-macos-command" aria-label="Copy macOS worker install command">${icon('copy')}</button></div></div><div><div class="hint" style="margin-bottom:6px">Windows · PowerShell</div><div class="copy-row"><code id="worker-install-windows-command" style="flex:1">${escapeHtml(windowsInstallCommand)}</code><button class="btn btn-icon" type="button" data-copy-target="worker-install-windows-command" aria-label="Copy Windows worker install command">${icon('copy')}</button></div></div></div></div>`;
  const workerLoginUnix = `./worker_mcp login --server ${loginServer} --roots /your/workspace`;
  const workerLoginWin = `.\\worker_mcp.exe login --server ${loginServer} --roots C:\\your\\workspace`;
  const enrollmentContent = enrollment
    ? `<div class="field" style="margin-top:14px"><span class="field-label">2. One-time enrollment token (expires ${escapeHtml(enrollment.expires_at)})</span><div class="copy-row"><div id="worker-enrollment-token" class="secret-box" style="flex:1">${escapeHtml(enrollment.token)}</div><button class="btn btn-icon" type="button" data-copy-target="worker-enrollment-token" aria-label="Copy enrollment token">${icon('copy')}</button></div><div class="hint">Shown only once. Keep this token private and use it promptly.</div></div><div class="field" style="margin-top:14px"><span class="field-label">3. Login & connect (prompts for token)</span><div class="hint">Linux / macOS</div><div class="copy-row"><code id="worker-login-unix-command" style="flex:1">${escapeHtml(directInstallAvailable ? workerLoginUnix.replace('./worker_mcp', 'worker_mcp') : workerLoginUnix)}</code><button class="btn btn-icon" type="button" data-copy-target="worker-login-unix-command" aria-label="Copy Unix Worker login command">${icon('copy')}</button></div><div class="hint" style="margin-top:8px">Windows · PowerShell</div><div class="copy-row"><code id="worker-login-win-command" style="flex:1">${escapeHtml(directInstallAvailable ? workerLoginWin.replace('.\\worker_mcp.exe', 'worker_mcp') : workerLoginWin)}</code><button class="btn btn-icon" type="button" data-copy-target="worker-login-win-command" aria-label="Copy Windows Worker login command">${icon('copy')}</button></div></div>${workerBaseIsHttps ? '' : '<div class="migration-note"><strong>HTTPS required for remote Worker connections</strong><span>Configure an HTTPS domain for MCP before connecting over the Internet. Do not use --insecure-http on a public network.</span></div>'}<div class="migration-note"><strong>Profile is created automatically</strong><span>Choose a name with --name during login if desired. Login creates the first execution profile automatically; refresh Workers to see it.</span></div>`
    : `<div class="field" style="margin-top:14px"><span class="field-label">2. Ready to connect?</span><div class="hint">${directInstallAvailable ? 'Install the signed Worker first.' : 'Development only: build the Worker locally from reviewed source first.'} Then generate a token (valid for 10 minutes) immediately before logging in.</div><form method="post" action="${escapeHtml(routeBase)}/enrollment" style="margin-top:10px"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="ttl_seconds" value="600"><button class="btn btn-primary" type="submit">${icon('key')} Generate one-time token</button></form></div>`;
  const enrollmentModal = canEnroll
    ? `<div id="worker-enrollment-modal" class="modal-backdrop" ${enrollment ? 'data-auto-open="true" data-static="true"' : ''} aria-hidden="true"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="worker-enrollment-title" aria-describedby="worker-enrollment-description"><div class="modal-header"><h2 id="worker-enrollment-title">Install & Connect Worker</h2><p id="worker-enrollment-description">${enrollment ? 'Your one-time token is ready. Copy it before closing this window.' : 'Install the Worker on your own machine before generating a one-time enrollment token.'}</p></div><div class="modal-body"><div class="secret-warning">${icon('shield')}<div>The Worker generates an Ed25519 identity locally. Your server receives only the public key; no inbound Worker port is required.</div></div>${directInstallAvailable ? approvedInstaller : unavailableInstaller}${enrollmentContent}</div><div class="modal-footer"><button class="btn btn-primary" type="button" data-modal-close>${enrollment ? "I've saved the token" : 'Close'}</button></div></div></div>`
    : '';
  const profileAction = onlineWorkers.length
    ? `<button type="button" class="btn" data-modal-open="worker-profile-modal">${icon('plus')} New Execution Target</button>`
    : '';
  const enrollmentAction = canEnroll
    ? `<button class="btn btn-primary" type="button" data-modal-open="worker-enrollment-modal">${icon('plus')} Install / Connect Worker</button>`
    : `<span role="status" class="badge badge-off">${signedReleaseApproved ? 'Trusted HTTPS Worker endpoint required — enrollment unavailable' : 'Signed Worker release approval pending — enrollment unavailable'}</span>`;
  const actions = `<div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="${escapeHtml(routeBase)}" aria-label="Refresh workers">${icon('refresh')} Refresh</a>${enrollmentAction}${profileAction}</div>`;
  const workerToolbar = `<div class="toolbar"><div class="search">${icon('search')}<input class="input" type="search" aria-label="Search workers" data-table-search="workers-table" placeholder="Search workers, status, capabilities..."></div><div style="display:flex;gap:6px;flex-wrap:wrap"><span class="badge badge-off">${workers.length} total</span><span class="badge badge-ok" data-worker-count="online">${onlineCount} online</span><span class="badge badge-off" data-worker-count="offline">${offlineCount} offline</span><span class="badge badge-off" data-worker-count="disabled">${disabledCount} disabled</span></div></div>`;
  const profileToolbar = `<div class="toolbar"><div class="search">${icon('search')}<input class="input" type="search" aria-label="Search worker profiles" data-table-search="worker-profiles-table" placeholder="Search profiles and workers..."></div><span class="badge badge-off">${profiles.length} profiles</span></div>`;
  const workerSection = `<section class="section"><div class="section-header"><div><h2 class="section-title">Enrolled Workers</h2><p class="section-subtitle">Search and manage machine identities as the fleet grows.</p></div>${icon('server')}</div><div class="section-body" style="padding-bottom:0">${workerToolbar}</div>${workers.length ? `<div class="table-wrap"><table id="workers-table" class="table" data-worker-status-url="${escapeHtml(routeBase)}/connection-status" data-worker-check="${escapeHtml(workers.some((worker) => worker.id === checkingWorkerId && worker.enabled) ? checkingWorkerId : '')}"><thead><tr><th>Worker</th>${accountUser ? '' : '<th>Owner</th>'}<th>Connection</th><th>Profiles</th><th>Last Seen</th><th>Capabilities</th><th></th></tr></thead><tbody>${workerRows}</tbody></table></div><div class="search-empty" data-search-empty="workers-table" hidden>No matching workers.</div>` : `<div class="empty"><div class="empty-icon">${icon('server')}</div><strong>No workers enrolled</strong><div>${canEnroll ? 'Start with Install / Connect Worker above. Installation and login create the first execution profile automatically.' : 'Worker enrollment is unavailable until signed release approval.'}</div></div>`}</section>`;
  const profileSection = `<section class="section" style="margin-top:16px"><div class="section-header"><div><h2 class="section-title">Execution Targets</h2><p class="section-subtitle">Stable aliases used by MCP workspace/file/git/process tools.</p></div></div><div class="section-body" style="padding-bottom:0">${profileToolbar}</div>${profiles.length ? `<div class="table-wrap"><table id="worker-profiles-table" class="table"><thead><tr><th>Profile</th><th>Worker</th><th>Status</th><th></th></tr></thead><tbody>${profileRows}</tbody></table></div><div class="search-empty" data-search-empty="worker-profiles-table" hidden>No matching worker profiles.</div>` : `<div class="empty"><div class="empty-icon">${icon('terminal')}</div><strong>No worker profiles yet</strong><div>Install and connect a Worker; its first execution profile is created automatically.</div></div>`}</section>`;
  const securitySection = `<section class="section" style="margin-top:16px"><div class="section-header"><div><h2 class="section-title">Worker Security</h2><p class="section-subtitle">The target machine initiates the connection; mcp_worker never needs an inbound worker port.</p></div>${icon('shield')}</div><div class="section-body"><div class="definition-grid"><div class="definition"><div class="definition-label">Network direction</div><div class="definition-value">Outbound WSS only</div></div><div class="definition"><div class="definition-label">Machine secret</div><div class="definition-value">Ed25519 private key stays local</div></div><div class="definition"><div class="definition-label">Inbound execution port</div><div class="definition-value">Not required</div></div><div class="definition"><div class="definition-label">Authority boundary</div><div class="definition-value">Worker OS user + allowed roots</div></div></div></div></section>`;
  const body = `${flashData(success, error)}${pageHeader('Workers', 'Outbound execution agents. Workers connect outward over secure WebSocket.', actions)}${workerSection}${profileSection}${securitySection}${profileModal}${workerEditModal}${enrollmentModal}`;
  return shell('Workers — mcp_worker', body, {
    admin: true,
    accountUser,
    active: accountUser ? 'account-workers' : 'workers',
    csrfToken,
    breadcrumb: 'Workers',
  });
}

function accountClientsPage({
  user,
  clients = [],
  mcpUrl = '/mcp',
  csrfToken,
  secret = null,
  success = '',
  error = '',
}: {
  user: PageUser;
  clients?: PageClient[];
  mcpUrl?: string;
  csrfToken: string;
  secret?: PageSecret | null;
  success?: string;
  error?: string;
}) {
  const rows = clients
    .map((c) => {
      const statusClass =
        c.status === 'active' ? 'badge-ok' : c.status === 'revoked' ? 'badge-danger' : 'badge-off';
      const last = c.last_authorized_at
        ? new Date(c.last_authorized_at).toLocaleString('en-GB')
        : 'Never';
      return `<tr><td data-label="Client"><div class="cell-title">${escapeHtml(c.display_name)}</div><div class="cell-sub mono">${escapeHtml(c.client_id)}</div></td><td data-label="Status"><span class="badge ${statusClass}">${escapeHtml(c.status)}</span></td><td data-label="Scopes">${c.allowed_scopes.map((s) => `<span class="code-chip">${escapeHtml(s)}</span>`).join('')}</td><td data-label="Last Authorized">${escapeHtml(last)}</td><td data-label="Actions" style="text-align:right"><details class="dropdown"><summary class="btn btn-icon btn-ghost" role="button" aria-haspopup="menu" aria-label="Actions for ${escapeHtml(c.display_name)}">${icon('more')}</summary><div class="menu" role="menu"><button type="button" role="menuitem" data-copy-value="${escapeHtml(c.client_id)}">${icon('copy')} Copy Client ID</button><form method="post" action="/account/clients/${escapeHtml(c.id)}/rotate" data-confirm-title="Rotate client secret?" data-confirm-message="The current secret will immediately stop working." data-confirm-action="Rotate Secret"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" role="menuitem">${icon('refresh')} Rotate Secret</button></form>${c.status === 'active' ? `<form method="post" action="/account/clients/${escapeHtml(c.id)}/disable"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" role="menuitem">${icon('power')} Disable</button></form>` : `<form method="post" action="/account/clients/${escapeHtml(c.id)}/enable"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" role="menuitem">${icon('power')} Enable</button></form>`}<form method="post" action="/account/clients/${escapeHtml(c.id)}/revoke" data-confirm-title="Revoke client tokens?" data-confirm-message="All issued tokens for this client will stop working." data-confirm-action="Revoke Tokens" data-confirm-danger="true"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="danger" type="submit" role="menuitem">${icon('shield')} Revoke Tokens</button></form><div class="menu-separator"></div><form method="post" action="/account/clients/${escapeHtml(c.id)}/delete" data-confirm-title="Delete OAuth client?" data-confirm-message="This removes the client and revokes its tokens." data-confirm-action="Delete Client" data-confirm-danger="true"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="danger" type="submit" role="menuitem">${icon('trash')} Delete Client</button></form></div></details></td></tr>`;
    })
    .join('');
  const createModal = oauthClientCreateModal({
    id: 'account-client-create-modal',
    action: '/account/clients',
    csrfToken,
    mcpUrl,
    personal: true,
  });
  const identity = `<section class="section" style="margin-bottom:16px"><div class="section-header"><div><h2 class="section-title">Client Profile</h2><p class="section-subtitle">Every client you create is bound to this identity.</p></div><span class="badge badge-ok">Isolated</span></div><div class="section-body"><div class="definition-grid"><div class="definition"><div class="definition-label">Principal ID</div><div class="definition-value mono">${escapeHtml(user.principal_id)}</div></div><div class="definition"><div class="definition-label">Profile ID</div><div class="definition-value mono">${escapeHtml(user.profile_id)}</div></div></div></div></section>`;
  const body = `${flashData(success, error)}${pageHeader('My Clients', 'Create and manage OAuth clients owned only by your account.', `<button class="btn btn-primary" type="button" data-modal-open="account-client-create-modal">${icon('plus')} New Client</button>`)}${identity}<section class="section">${clients.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Client</th><th>Status</th><th>Scopes</th><th>Last Authorized</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty"><div class="empty-icon">${icon('key')}</div><strong>No clients yet</strong><div>Create your first OAuth client to connect an MCP consumer.</div></div>`}</section>${createModal}${secretModal(secret)}`;
  return shell('My Clients — mcp_worker', body, {
    admin: true,
    accountUser: user,
    active: 'account-clients',
    csrfToken,
    breadcrumb: 'My Clients',
  });
}

function accountTelegramPage({
  user,
  config,
  csrfToken,
  success = '',
  error = '',
}: {
  user: PageUser;
  config: PageTelegram;
  csrfToken: string;
  success?: string;
  error?: string;
}) {
  const modalId = 'account-telegram-modal';
  const modal = telegramConfigurationModal({
    id: modalId,
    action: '/account/telegram',
    csrfToken,
    config,
    description: 'Configure the Telegram destination owned only by your account.',
  });
  const actions = `<button class="btn btn-primary" type="button" data-modal-open="${modalId}">${icon('pencil')} Edit Configuration</button>`;
  const secondaryRows = `<div class="status-row"><div><div class="status-row-title">Owner</div><div class="status-row-sub">Configuration namespace</div></div><strong>${escapeHtml(user.username)}</strong></div><div class="status-row"><div><div class="status-row-title">Admin Telegram</div><div class="status-row-sub">Never inherited by this account</div></div><span class="badge badge-off">Separate</span></div><div class="status-row"><div><div class="status-row-title">Storage</div><div class="status-row-sub">Token encryption</div></div><span class="badge badge-ok">Encrypted</span></div>`;
  const summary = telegramSummary({
    title: 'My Telegram',
    subtitle: `Private notification channel for ${user.display_name || user.username}.`,
    config,
    csrfToken,
    editModalId: modalId,
    testAction: '/account/telegram/test',
    secondaryTitle: 'Isolation',
    secondarySubtitle: 'Your Telegram credentials are separate from Admin configuration.',
    secondaryRows,
  });
  const body = `${flashData(success, error)}${pageHeader('Telegram', 'Configure a private Telegram notification channel for your account.', actions)}${summary}${modal}`;
  return shell('Telegram — mcp_worker', body, {
    admin: true,
    accountUser: user,
    active: 'account-telegram',
    csrfToken,
    breadcrumb: 'Telegram',
  });
}

function settingsPage({
  activeSection = 'database',
  storage,
  mcp,
  telegram,
  runtime,
  csrfToken,
  success = '',
  error = '',
}: {
  activeSection?: string;
  storage: PageStorage;
  mcp: PageMcp;
  telegram: PageTelegram;
  runtime: PageRuntime;
  csrfToken: string;
  success?: string;
  error?: string;
}) {
  const sections = ['database', 'mcp', 'telegram', 'runtime'];
  const active = sections.includes(activeSection) ? activeSection : 'database';
  const stateClass = storage.state === 'READY' ? 'badge-ok' : 'badge-danger';
  const operational = Boolean(storage.operational);
  const disabled = operational ? '' : ' disabled';
  const labels = { database: 'Database', mcp: 'MCP', telegram: 'Telegram', runtime: 'Runtime' };
  const subtitles = {
    database: 'Inspect the SQLite database state.',
    mcp: 'Configure OAuth and MCP runtime behavior.',
    telegram: 'Configure the optional Telegram support channel.',
    runtime: 'Inspect read-only bootstrap and runtime information.',
  };
  const dbDescription = operational
    ? 'SQLite is ready on persistent local storage (WAL enabled).'
    : storage.lastError?.message ||
      'SQLite is unavailable. Run ./setup.sh --init only for a fresh installation.';
  const databaseSection = `<section class="section settings-detail"><div class="section-header"><div><h2 class="section-title">Database</h2><p class="section-subtitle">SQLite-only; all application data is stored locally.</p></div><span class="badge ${stateClass}">${escapeHtml(storage.state)}</span></div><div class="section-body"><p class="muted">${escapeHtml(dbDescription)}</p><p class="hint">Storage path is configured by DATABASE_PATH. Keep APP_ENCRYPTION_KEY and the SQLite volume across upgrades; backup with a consistent snapshot.</p></div></section>`;

  const mcpSection = `<section class="section settings-detail"><div class="section-header"><div><h2 class="section-title">MCP</h2><p class="section-subtitle">OAuth and MCP behavior stored in the active application database.</p></div><span class="badge ${operational ? 'badge-ok' : 'badge-off'}">${operational ? 'Available' : 'Database required'}</span></div><div class="section-body"><form method="post" action="/admin/settings/mcp" class="stack" data-disable-on-submit><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><fieldset class="settings-fieldset"${disabled}><div class="form-grid">
    <div class="field full"><span class="field-label">Status</span><label class="switch-row" for="mcp-enabled"><span><strong>MCP enabled</strong><span class="hint">Accept OAuth and MCP requests when the database is operational.</span></span><input id="mcp-enabled" name="enabled" type="checkbox" value="true" ${mcp.enabled ? 'checked' : ''}><span class="switch-control" aria-hidden="true"></span></label></div>
    <div class="field full"><label for="mcp-public-base-url">Public Base URL</label><input id="mcp-public-base-url" name="public_base_url" value="${escapeHtml(mcp.publicBaseUrl)}" required placeholder="https://example.com"><div class="hint">Canonical MCP resource will be ${escapeHtml(mcp.publicBaseUrl)}/mcp.</div></div>
    <div class="field"><label for="mcp-access-ttl">Access token TTL (seconds)</label><input id="mcp-access-ttl" name="access_token_ttl_seconds" type="number" min="60" max="86400" value="${escapeHtml(mcp.accessTokenTtlSeconds)}"></div>
    <div class="field"><label for="mcp-refresh-ttl">Refresh token TTL (seconds)</label><input id="mcp-refresh-ttl" name="refresh_token_ttl_seconds" type="number" min="3600" max="31536000" value="${escapeHtml(mcp.refreshTokenTtlSeconds)}"></div>
    <div class="field"><label for="mcp-code-ttl">Authorization code TTL (seconds)</label><input id="mcp-code-ttl" name="auth_code_ttl_seconds" type="number" min="60" max="3600" value="${escapeHtml(mcp.authCodeTtlSeconds)}"></div>
    <div class="field"><label for="mcp-rate-limit">Rate limit / minute</label><input id="mcp-rate-limit" name="rate_limit_per_minute" type="number" min="1" max="10000" value="${escapeHtml(mcp.rateLimitPerMinute)}"></div>
  </div><div class="settings-actions"><button class="btn btn-primary" type="submit">Save MCP Settings</button></div></fieldset></form></div></section>`;

  const telegramModalId = 'settings-telegram-modal';
  const telegramModal = telegramConfigurationModal({
    id: telegramModalId,
    action: '/admin/settings/telegram',
    csrfToken,
    config: telegram,
    description: 'Configure the Admin Telegram support channel.',
  });
  const telegramRows = `<div class="status-row"><div><div class="status-row-title">Owner</div><div class="status-row-sub">Configuration namespace</div></div><strong>Admin</strong></div><div class="status-row"><div><div class="status-row-title">User Telegram</div><div class="status-row-sub">Never inherited from Admin</div></div><span class="badge badge-off">Separate</span></div><div class="status-row"><div><div class="status-row-title">Storage</div><div class="status-row-sub">Database + AES-256-GCM token encryption</div></div><span class="badge badge-ok">Encrypted</span></div>`;
  const telegramActions = `<button class="btn btn-primary" type="button" data-modal-open="${telegramModalId}"${disabled}>${icon('pencil')} Edit Configuration</button>`;
  const telegramSection = `${telegramSummary({ title: 'Admin Telegram', subtitle: 'Optional support notification channel for the mcp_worker administrator.', config: telegram, csrfToken, editModalId: telegramModalId, testAction: '/admin/settings/telegram/test', secondaryTitle: 'Isolation', secondarySubtitle: 'Admin and user Telegram credentials stay in separate namespaces.', secondaryRows: telegramRows, editDisabled: disabled })}${telegramModal}`;

  const runtimeSection = `<section class="section settings-detail"><div class="section-header"><div><h2 class="section-title">Runtime</h2><p class="section-subtitle">Read-only bootstrap values that remain outside application settings.</p></div></div><div class="section-body"><div class="definition-grid"><div class="definition"><div class="definition-label">Version</div><div class="definition-value">v${escapeHtml(runtime.version)}</div></div><div class="definition"><div class="definition-label">Git SHA</div><div class="definition-value mono">${escapeHtml(runtime.gitSha || 'unknown')}</div></div><div class="definition"><div class="definition-label">Environment</div><div class="definition-value">${escapeHtml(runtime.nodeEnv)}</div></div><div class="definition"><div class="definition-label">MCP tools</div><div class="definition-value">${escapeHtml(runtime.toolCount)}</div></div></div><div class="migration-note"><strong>Bootstrap-only ENV</strong><span>ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET, APP_ENCRYPTION_KEY (or legacy TERMINAL_CREDENTIAL_KEY), HOST/PORT, TRUST_PROXY and COOKIE_SECURE remain environment-level security/runtime configuration.</span></div></div></section>`;

  const content = {
    database: databaseSection,
    mcp: mcpSection,
    telegram: telegramSection,
    runtime: runtimeSection,
  }[active as 'database' | 'mcp' | 'telegram' | 'runtime'];
  const pageAction =
    active === 'database'
      ? `<span class="badge ${stateClass}">${escapeHtml(storage.state)}</span>`
      : active === 'telegram'
        ? telegramActions
        : '';
  const body = `${flashData(success, error)}${pageHeader(labels[active as keyof typeof labels], subtitles[active as keyof typeof subtitles], pageAction)}<div class="settings-content">${content}</div>`;
  return shell(`${labels[active as keyof typeof labels]} Settings — mcp_worker`, body, {
    admin: true,
    active: 'settings',
    settingsSection: active,
    csrfToken,
    breadcrumb: `Settings / ${labels[active as keyof typeof labels]}`,
  });
}

function setupRequiredPage({ status, csrfToken }: { status: PageStorage; csrfToken: string }) {
  const body = `${pageHeader('SQLite setup required', 'Application data features need a verified SQLite database.')}
  <section class="section"><div class="empty setup-required"><div class="empty-icon">${icon('database')}</div><strong>SQLite database unavailable</strong><div>${escapeHtml(status.lastError?.message || 'For a fresh installation run ./setup.sh --init. Verify volume permissions if initialization is refused.')}</div><br><a class="btn btn-primary" href="/admin/settings/database">Database status</a></div></section>`;
  return shell('Database setup required — mcp_worker', body, {
    admin: true,
    active: 'settings',
    csrfToken,
    breadcrumb: 'Setup Required',
  });
}

function errorPage(status: number, message: string) {
  return shell(
    `${status} Error`,
    `<div class="login-shell"><div class="login-card"><h1>${escapeHtml(status)} Error</h1><p>${escapeHtml(message)}</p><a class="btn" href="/admin">Return to Admin</a></div></div>`,
  );
}

export = {
  workerInstallCommand,
  onboardingPage,
  escapeHtml,
  loginPage,
  oauthConsentPage,
  adminOverviewPage,
  clientsPage,
  auditPage,
  telegramPage,
  workersPage,
  accountClientsPage,
  accountTelegramPage,
  settingsPage,
  setupRequiredPage,
  errorPage,
};
