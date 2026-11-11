const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { setupEnv, cleanup, initDb } = require('./helper');

const env = setupEnv('admin-ui');
initDb();
const app = require('../src/app');
let server;
let baseUrl;
let cookie;
let csrf;
let adminWorker;
let originalWorkerIsOnline;

function extractCsrf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
}

async function login() {
  const page = await fetch(`${baseUrl}/login`);
  const html = await page.text();
  const initialCookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const loginCsrf = extractCsrf(html);
  assert.ok(initialCookie);
  assert.ok(loginCsrf);
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: initialCookie },
    body: new URLSearchParams({
      _csrf: loginCsrf,
      username: 'admin',
      password: 'TestAdminPassword2026!',
      returnTo: '/admin'
    }).toString()
  });
  assert.equal(response.status, 302);
  cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  const admin = await fetch(`${baseUrl}/admin`, { headers: { cookie } });
  const adminHtml = await admin.text();
  csrf = extractCsrf(adminHtml);
  assert.ok(csrf);
  return adminHtml;
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await login();
  const workerRepo = require('../src/repositories/workerRepository');
  const workerBroker = require('../src/services/workerConnectionBroker');
  adminWorker = await workerRepo.createWorker({
    name: 'UI-Admin-Worker',
    publicKey: 'test-public-key',
    capabilities: ['tmux.inspect', 'tmux.send', 'tmux.read', 'tmux.interrupt']
  });
  originalWorkerIsOnline = workerBroker.isOnline.bind(workerBroker);
  workerBroker.isOnline = workerId => workerId === adminWorker.id || originalWorkerIsOnline(workerId);
});

test.after(async () => {
  const workerBroker = require('../src/services/workerConnectionBroker');
  if (originalWorkerIsOnline) workerBroker.isOnline = originalWorkerIsOnline;
  if (server) await new Promise(resolve => server.close(resolve));
  cleanup(env.dir);
});

test('root redirects to authenticated admin console with configuration navigation', async () => {
  const root = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/admin');

  const admin = await fetch(`${baseUrl}/admin`, { headers: { cookie } });
  assert.equal(admin.status, 200);
  const html = await admin.text();
  assert.match(html, /Overview/);
  assert.match(html, /Data Store/);
  assert.match(html, /Settings/);
  assert.match(html, /OAuth Clients/);
  assert.match(html, /Audit Log/);
  assert.match(html, /SSH Profiles/);
  assert.match(html, /Telegram/);
  assert.doesNotMatch(html, /Antigravity|Control Plane|Bot Inbox/);
});

test('OAuth client can be created from admin UI and secret is shown once', async () => {
  const response = await fetch(`${baseUrl}/admin/clients`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      _csrf: csrf,
      display_name: 'UI Client',
      principal_id: 'principal:ui_client',
      redirect_uris: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scopes: 'bot_report.read bot_report.terminal offline_access'
    }).toString()
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/clients');
  const firstGet = await fetch(`${baseUrl}/admin/clients`, { headers: { cookie } });
  const html = await firstGet.text();
  assert.match(html, /OAuth client created/);
  assert.match(html, /Client secret created/);
  assert.match(html, /br_sec_/);
  const secondGet = await fetch(`${baseUrl}/admin/clients`, { headers: { cookie } });
  assert.doesNotMatch(await secondGet.text(), /Client secret created/);
  const clients = await require('../src/repositories/mcpOAuthRepository').listClients();
  const matching = clients.filter(client => client.display_name === 'UI Client');
  assert.equal(matching.length, 1);
  assert.equal(matching[0].status, 'active');
});

test('Audit Log traces MCP activity by client, tool, result, and request id', async () => {
  const repo = require('../src/repositories/mcpOAuthRepository');
  const client = (await repo.listClients()).find(item => item.display_name === 'UI Client');
  assert.ok(client);

  await repo.recordAudit({
    id: 'aud_ui_audit_success',
    requestId: 'req_ui_audit_success',
    clientId: client.client_id,
    principalId: client.principal_id,
    mcpMethod: 'tools/call',
    toolName: 'runtime_info',
    result: 'SUCCESS',
    httpStatus: 200,
    durationMs: 12,
    requestPayload: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'runtime_info', arguments: {} } }),
    responsePayload: JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'runtime ok' }] } })
  });
  await repo.recordAudit({
    requestId: 'req_ui_audit_error',
    clientId: client.client_id,
    principalId: client.principal_id,
    mcpMethod: 'tools/call',
    toolName: 'terminal_list',
    result: 'ERROR',
    httpStatus: 500,
    durationMs: 31
  });

  const response = await fetch(`${baseUrl}/admin/audit?client_id=${encodeURIComponent(client.client_id)}&tool_name=runtime_info&result=SUCCESS`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Audit Log/);
  assert.match(html, /UI Client/);
  assert.match(html, /runtime_info/);
  assert.match(html, /SUCCESS/);
  assert.match(html, /req_ui_audit_success/);
  assert.match(html, /data-audit-detail="aud_ui_audit_success"/);
  assert.match(html, /Audit Event Detail/);
  assert.doesNotMatch(html, /req_ui_audit_error/);

  const detailResponse = await fetch(`${baseUrl}/admin/audit/aud_ui_audit_success`, { headers: { cookie } });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.tool_name, 'runtime_info');
  assert.match(detail.request_payload, /tools\/call/);
  assert.match(detail.response_payload, /runtime ok/);
});

test('Audit Log uses compact numbered pagination with configurable page size', async () => {
  const repo = require('../src/repositories/mcpOAuthRepository');
  const client = (await repo.listClients()).find(item => item.display_name === 'UI Client');
  assert.ok(client);
  for (let index = 0; index < 25; index += 1) {
    await repo.recordAudit({
      requestId: `req_ui_bulk_${String(index).padStart(2, '0')}`,
      clientId: client.client_id,
      principalId: client.principal_id,
      mcpMethod: 'tools/call',
      toolName: 'repo_snapshot',
      result: 'SUCCESS',
      httpStatus: 200,
      durationMs: 5 + index
    });
  }

  const first = await fetch(`${baseUrl}/admin/audit`, { headers: { cookie } });
  assert.equal(first.status, 200);
  const firstHtml = await first.text();
  assert.match(firstHtml, /Audit log pagination/);
  assert.match(firstHtml, /Rows/);
  assert.match(firstHtml, /name="per_page"/);
  assert.match(firstHtml, /aria-label="Next page"/);
  assert.equal((firstHtml.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g) || []).length, 20);

  const second = await fetch(`${baseUrl}/admin/audit?page=2&per_page=20`, { headers: { cookie } });
  assert.equal(second.status, 200);
  const secondHtml = await second.text();
  assert.match(secondHtml, /aria-current="page">2<\/a>/);
  assert.match(secondHtml, /aria-label="Previous page"/);

  const fifty = await fetch(`${baseUrl}/admin/audit?per_page=50`, { headers: { cookie } });
  const fiftyHtml = await fifty.text();
  assert.match(fiftyHtml, /<option value="50" selected>50<\/option>/);
});

test('Admin SSH Profile is created through an active global Worker without SSH credentials', async () => {
  const response = await fetch(`${baseUrl}/admin/terminals`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      _csrf: csrf,
      name: 'UI-Terminal',
      description: 'Created from admin UI',
      worker_id: adminWorker.id,
      enabled: 'true'
    }).toString()
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/terminals');
  const workerRepo = require('../src/repositories/workerRepository');
  const profile = (await workerRepo.listAdminProfiles()).find(item => item.name === 'UI-Terminal');
  assert.ok(profile);
  assert.equal(profile.worker_id, adminWorker.id);
  assert.equal(profile.tmux_session, '');

  const page = await fetch(`${baseUrl}/admin/terminals`, { headers: { cookie } });
  const html = await page.text();
  assert.match(html, /Profiles are created automatically with each Worker/);
  assert.match(html, /UI-Admin-Worker/);
  assert.doesNotMatch(html, /name="host"|name="port"|name="username"|name="password"/);
});

test('Admin SSH Profile edit keeps Worker-backed metadata only', async () => {
  const workerRepo = require('../src/repositories/workerRepository');
  const profile = (await workerRepo.listAdminProfiles()).find(item => item.name === 'UI-Terminal');
  assert.ok(profile);
  const response = await fetch(`${baseUrl}/admin/terminals/${profile.id}/update`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      _csrf: csrf,
      name: 'UI-Terminal-Edited',
      description: 'Updated from modal',
      worker_id: adminWorker.id,
      enabled: 'true'
    }).toString()
  });
  assert.equal(response.status, 302);
  const updated = await workerRepo.findAdminProfileById(profile.id);
  assert.equal(updated.name, 'UI-Terminal-Edited');
  assert.equal(updated.worker_id, adminWorker.id);
  assert.equal(updated.tmux_session, '');
  assert.equal(updated.enabled, true);
  assert.equal('host' in updated, false);
  assert.equal('username' in updated, false);
  assert.equal('credential_envelope' in updated, false);
});

test('Admin SSH Profile tests direct Worker shell and exposes Attach Shell', async () => {
  const workerRepo = require('../src/repositories/workerRepository');
  const profile = (await workerRepo.listAdminProfiles()).find(item => item.name === 'UI-Terminal-Edited');
  assert.ok(profile);

  const workerExecution = require('../src/services/workerExecutionService');
  const originalTest = workerExecution.testConnection;
  workerExecution.testConnection = async workerProfile => {
    assert.equal(workerProfile.id, profile.id);
    assert.equal(workerProfile.worker_id, adminWorker.id);
    return { pane_count: 1, target_pane: 'ui-terminal-edit:0.0', pane_current_command: 'bash' };
  };

  try {
    const testResponse = await fetch(`${baseUrl}/admin/terminals/${profile.id}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString()
    });
    assert.equal(testResponse.status, 200);
    const result = await testResponse.json();
    assert.equal(result.code, 'TEST_OK');
    assert.equal(result.pane_count, 1);
    assert.equal(result.target_pane, 'ui-terminal-edit:0.0');

    const listPage = await fetch(`${baseUrl}/admin/terminals`, { headers: { cookie } });
    const listHtml = await listPage.text();
    assert.match(listHtml, /Attach Shell/);
    assert.match(listHtml, /Test Shell/);
    assert.doesNotMatch(listHtml, /name="tmux_session"|name="host"|name="username"|name="password"/);

    const legacyConsole = await fetch(`${baseUrl}/admin/terminals/${profile.id}/ssh`, { redirect: 'manual', headers: { cookie } });
    assert.equal(legacyConsole.status, 302);
    assert.equal(legacyConsole.headers.get('location'), `/admin/terminals/${profile.id}/shell`);

    const consolePage = await fetch(`${baseUrl}/admin/terminals/${profile.id}/shell`, { headers: { cookie } });
    assert.equal(consolePage.status, 200);
    assert.match(await consolePage.text(), /Interactive PTY attached directly to the Worker OS shell/);

    const ticketResponse = await fetch(`${baseUrl}/admin/terminals/${profile.id}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', origin: baseUrl, cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString()
    });
    assert.equal(ticketResponse.status, 201);
    const ticket = await ticketResponse.json();
    assert.match(ticket.ws_url, /^ws:\/\/|^wss:\/\//);
    assert.match(ticket.ws_url, /\/terminal\/ws\?/);
  } finally {
    workerExecution.testConnection = originalTest;
  }
});

test('modern admin assets are served and Worker-backed SSH modal hooks are present', async () => {
  const css = await fetch(`${baseUrl}/assets/admin.css`);
  const js = await fetch(`${baseUrl}/assets/admin.js`);
  assert.equal(css.status, 200);
  assert.equal(js.status, 200);
  assert.match(await css.text(), /\.modal-backdrop/);
  assert.match(await js.text(), /data-modal-open/);
  const page = await fetch(`${baseUrl}/admin/terminals`, { headers: { cookie } });
  const html = await page.text();
  assert.doesNotMatch(html, /data-account-ssh-new|New SSH Profile/);
  assert.match(html, /data-account-ssh-edit/);
  assert.match(html, /id="account-ssh-modal"/);
  assert.doesNotMatch(html, /id="terminal-modal"|terminal-host|terminal-password/);
});

test('Telegram config UI stores operational settings in DB and encrypts token with the application credential key', async () => {
  const dedicatedTelegramKey = process.env.TELEGRAM_CREDENTIAL_KEY;
  process.env.TELEGRAM_CREDENTIAL_KEY = 'legacy-telegram-key-is-not-used-for-new-data';
  const response = await fetch(`${baseUrl}/admin/settings/telegram`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      _csrf: csrf,
      enabled: 'true',
      bot_token: '123456:ABCdef_TestToken',
      chat_id: '987654321'
    }).toString()
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/settings/telegram');
  const settings = require('../src/repositories/settingsRepository');
  const encrypted = await settings.get('telegram.bot_token');
  assert.ok(encrypted.startsWith('enc:v3:'));
  assert.notEqual(encrypted, '123456:ABCdef_TestToken');
  assert.equal(await settings.get('telegram.enabled'), 'true');
  assert.equal(await settings.get('telegram.chat_id'), '987654321');
  assert.equal(require('../src/services/telegramSecretService').decrypt(encrypted), '123456:ABCdef_TestToken');

  const page = await fetch(`${baseUrl}/admin/settings/telegram`, { headers: { cookie } });
  const html = await page.text();
  assert.match(html, /Stored securely/);
  assert.doesNotMatch(html, /123456:ABCdef_TestToken/);
  if (dedicatedTelegramKey === undefined) delete process.env.TELEGRAM_CREDENTIAL_KEY;
  else process.env.TELEGRAM_CREDENTIAL_KEY = dedicatedTelegramKey;
});

test('legacy Telegram v2 token is migrated to DB-backed v3 envelope without losing the token', async () => {
  const legacyKey = process.env.TELEGRAM_CREDENTIAL_KEY;
  assert.ok(legacyKey);
  const key = Buffer.from(legacyKey, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('bot_report:telegram-token:v2', 'utf8'));
  const ciphertext = Buffer.concat([cipher.update('654321:LegacyTelegramToken', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const legacyEnvelope = ['enc:v2', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');

  const settings = require('../src/repositories/settingsRepository');
  await settings.delete('telegram.bot_token');
  await settings.set('telegram_mcp_bot_token', legacyEnvelope);
  await settings.set('telegram_mcp_chat_id', '1122334455');

  const response = await fetch(`${baseUrl}/admin/settings/telegram`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({
      _csrf: csrf,
      enabled: 'true',
      bot_token: '',
      chat_id: '1122334455'
    }).toString()
  });
  assert.equal(response.status, 302);

  const migrated = await settings.get('telegram.bot_token');
  assert.ok(migrated.startsWith('enc:v3:'));
  assert.equal(require('../src/services/telegramSecretService').decrypt(migrated), '654321:LegacyTelegramToken');
});
