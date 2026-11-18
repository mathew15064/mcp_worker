import pages from './pages';

type User = {
  id: string;
  username: string;
  email?: string | null;
  display_name?: string | null;
  status: string;
  created_at?: string;
  last_login_at?: string | null;
};
type Activity = {
  created_at?: string | null;
  mcp_method?: string | null;
  tool_name?: string | null;
  result?: string | null;
  http_status?: number;
};
const esc = pages.escapeHtml;

function registrationPage({
  csrfToken,
  open,
  error = '',
  success = '',
}: {
  csrfToken: string;
  open: boolean;
  error?: string;
  success?: string;
}) {
  const fields = open
    ? `<form method="post" action="/register" class="stack" data-disable-on-submit>
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <div class="field"><label for="reg-username">Username</label><input id="reg-username" name="username" autocomplete="username" minlength="3" maxlength="64" required></div>
        <div class="field"><label for="reg-email">Email</label><input id="reg-email" type="email" name="email" autocomplete="email" maxlength="254" required></div>
        <div class="field"><label for="reg-name">Display name</label><input id="reg-name" name="display_name" maxlength="120" required></div>
        <div class="field"><label for="reg-password">Password (10+ characters)</label><input id="reg-password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="256" required></div>
        <button class="btn btn-primary" type="submit">Request access</button>
      </form>`
    : '<div class="alert">Registration is currently closed by the administrator.</div>';
  return pages.shell(
    'Request MCP access',
    `<div class="login-shell"><div class="login-card"><div class="login-brand"><div class="brand-mark">MW</div><strong>MCP Worker Hosted</strong></div><h1>Create an account</h1><p>New accounts require administrator approval before sign-in.</p>
    ${error ? `<div class="alert alert-error" role="alert">${esc(error)}</div>` : ''}${success ? `<div class="alert" role="status">${esc(success)}</div>` : ''}
    ${fields}<p class="hint"><a href="/login">Already approved? Sign in</a></p></div></div>`,
  );
}

function pendingPage() {
  return pages.shell(
    'Account pending',
    '<div class="login-shell"><div class="login-card"><h1>Registration received</h1><p>Your account is pending administrator approval. Sign in after approval.</p><a class="btn btn-primary" href="/login">Back to sign in</a></div></div>',
  );
}

function actionForm(id: string, action: string, label: string, csrfToken: string) {
  return `<form method="post" action="/admin/users/${encodeURIComponent(id)}/${action}" class="inline-form"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><button type="submit" class="btn btn-ghost" data-confirm="${esc(label)} this user?">${esc(label)}</button></form>`;
}

function adminUsersPage({
  users,
  csrfToken,
  registrationOpen,
  hostedExecutionEnabled,
  success = '',
  error = '',
}: {
  users: User[];
  csrfToken: string;
  registrationOpen: boolean;
  hostedExecutionEnabled: boolean;
  success?: string;
  error?: string;
}) {
  const rows = users
    .map(
      (
        u,
      ) => `<tr><td><strong>${esc(u.username)}</strong><div class="hint">${esc(u.display_name || '')}</div></td><td>${esc(u.email || '—')}</td><td><span class="badge">${esc(u.status)}</span></td><td>${esc(u.last_login_at || '—')}</td><td>
   <div class="inline-actions">
    ${u.status !== 'active' ? actionForm(u.id, 'approve', 'Approve', csrfToken) : ''}
    ${u.status !== 'disabled' ? actionForm(u.id, 'disable', 'Disable', csrfToken) : actionForm(u.id, 'enable', 'Enable', csrfToken)}
    ${u.status === 'pending' ? actionForm(u.id, 'reject', 'Reject', csrfToken) : ''}
   </div>
   <form method="post" action="/admin/users/${encodeURIComponent(u.id)}/reset-password" class="inline-actions">
     <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
     <input aria-label="New password for ${esc(u.username)}" type="password" name="password" minlength="10" maxlength="256" placeholder="New password" autocomplete="new-password" required>
     <button type="submit" class="btn btn-ghost">Reset</button>
   </form></td></tr>`,
    )
    .join('');
  const page = `
    ${pages.pageHeader('Users', 'Review registrations, create users, manage access and revoke sessions.')}
    ${pages.escapeHtml(error) ? `<div class="alert alert-error" role="alert">${esc(error)}</div>` : ''}
    ${pages.escapeHtml(success) ? `<div class="alert" role="status">${esc(success)}</div>` : ''}
    <section class="section"><div class="section-header"><h2 class="section-title">Registration</h2></div><div class="section-body">
       <form method="post" action="/admin/registration" class="inline-actions"><input type="hidden" name="_csrf" value="${esc(csrfToken)}">
       <label><input type="checkbox" name="enabled" value="true" ${registrationOpen ? 'checked' : ''}> Allow public registration (approval required)</label>
       <button class="btn btn-primary" type="submit">Save</button></form>
    </div></section>
    <section class="section" style="margin-top:16px"><div class="section-header"><h2 class="section-title">Hosted execution</h2></div><div class="section-body">
      <form method="post" action="/admin/hosted" class="inline-actions"><input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <label><input type="checkbox" name="enabled" value="true" ${hostedExecutionEnabled ? 'checked' : ''}> Allow terminal execution on verified, isolated per-user workers</label>
      <button class="btn btn-primary" type="submit">Save</button></form>
      <p class="hint">Enable only after the host operator has provisioned and attested isolated worker containers. All other workers remain inaccessible.</p>
    </div></section>
    <section class="section" style="margin-top:16px"><div class="section-header"><h2 class="section-title">Create user</h2></div><div class="section-body">
      <form method="post" action="/admin/users" class="form-grid">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <div class="field"><label>Username</label><input name="username" minlength="3" maxlength="64" required></div>
        <div class="field"><label>Email</label><input type="email" name="email" maxlength="254"></div>
        <div class="field"><label>Display name</label><input name="display_name" maxlength="120" required></div>
        <div class="field"><label>Initial password</label><input type="password" name="password" minlength="10" maxlength="256" autocomplete="new-password" required></div>
        <button class="btn btn-primary" type="submit">Create active user</button>
      </form></div></section>
    <section class="section" style="margin-top:16px"><div class="section-header"><h2 class="section-title">All users (${users.length})</h2></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Email</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No users yet.</td></tr>'}</tbody></table></div></section>`;
  return pages.shell('Users', page, { admin: true, active: 'users', csrfToken });
}

function userHomePage({
  user,
  clients,
  endpoint,
  csrfToken,
}: {
  user: User;
  clients: number;
  endpoint: string;
  csrfToken: string;
}) {
  const body = `${pages.pageHeader('Home', 'Your managed MCP connection. No VPS, Docker or DNS setup required.')}
    <section class="section"><div class="section-body"><h2 class="section-title">Welcome, ${esc(user.display_name || user.username)}</h2>
      <p>Account status: <strong>${esc(user.status)}</strong>. OAuth clients: <strong>${clients}</strong>.</p>
      <p>Your MCP endpoint: <code>${esc(endpoint)}</code></p>
      <p>Connect ChatGPT using the MCP URL, then sign in to authorize access. Execution tools remain disabled until an isolated runtime is provisioned.</p>
      <a class="btn btn-primary" href="/account/connect">Connect ChatGPT</a>
    </div></section>`;
  return pages.shell('Home', body, {
    admin: true,
    accountUser: user,
    active: 'account-home',
    csrfToken,
  });
}

function userToolsPage({
  user,
  csrfToken,
  hasWorker,
}: {
  user: User;
  csrfToken: string;
  hasWorker: boolean;
}) {
  const body = `${pages.pageHeader('My Tools', 'Tools available under your own account permissions.')}
    <section class="section"><div class="section-body"><p><strong>runtime_info</strong> — available with read scope.</p>
    <p>Terminal/file/git/process tools — ${hasWorker ? 'Your own execution profile is configured; access still requires terminal scope.' : 'Unavailable until an isolated worker is provisioned and enabled.'}</p></div></section>`;
  return pages.shell('My Tools', body, {
    admin: true,
    accountUser: user,
    active: 'account-tools',
    csrfToken,
  });
}

function userActivityPage({
  user,
  csrfToken,
  activity,
}: {
  user: User;
  csrfToken: string;
  activity: Activity[];
}) {
  const rows = activity
    .map(
      (a) =>
        `<tr><td>${esc(a.created_at || '')}</td><td>${esc(a.mcp_method || '')}</td><td>${esc(a.tool_name || '—')}</td><td>${esc(a.result || '')}</td><td>${esc(a.http_status || '')}</td></tr>`,
    )
    .join('');
  const body = `${pages.pageHeader('Activity', 'Recent requests for your identity only.')}
    <section class="section"><div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Method</th><th>Tool</th><th>Result</th><th>HTTP</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No recent activity.</td></tr>'}</tbody></table></div></section>`;
  return pages.shell('Activity', body, {
    admin: true,
    accountUser: user,
    active: 'account-activity',
    csrfToken,
  });
}

function connectPage({
  user,
  endpoint,
  csrfToken,
}: {
  user: User;
  endpoint: string;
  csrfToken: string;
}) {
  const body = `${pages.pageHeader('Connect ChatGPT', 'Connect once to the shared hosted MCP endpoint.')}
    <section class="section"><div class="section-header"><h2 class="section-title">Your MCP URL</h2></div><div class="section-body">
      <p>In ChatGPT, add a new MCP connector and enter this URL:</p>
      <div class="copy-row"><code id="hosted-mcp-url" style="flex:1">${esc(endpoint)}</code><button class="btn" type="button" data-copy-target="hosted-mcp-url">Copy URL</button></div>
      <p>Continue with OAuth, then sign in using your approved MCP Worker account (<strong>${esc(user.username)}</strong>).
      The server supports public OAuth client registration with PKCE; no VPS, Docker or personal OAuth server is needed.</p>
      <p class="hint">If your ChatGPT workspace requires manual client credentials, use <a href="/account/clients">advanced OAuth client management</a>.</p>
      <p class="hint">Your access is isolated from other users. Terminal access remains disabled until an administrator provisions a verified isolated runtime.</p>
    </div></section>`;
  return pages.shell('Connect ChatGPT', body, {
    admin: true,
    accountUser: user,
    active: 'account-clients',
    csrfToken,
  });
}

export = {
  registrationPage,
  pendingPage,
  adminUsersPage,
  userHomePage,
  userToolsPage,
  userActivityPage,
  connectPage,
};
