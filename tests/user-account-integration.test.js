const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const enabled = Boolean(process.env.MYSQL_TEST_HOST);

function extractCsrf(html) { return html.match(/name="_csrf" value="([^"]+)"/)?.[1] || ''; }
function cookieFrom(response) { return (response.headers.get('set-cookie') || '').split(';')[0]; }

async function adminConnection(database) {
  const mysql = require('mysql2/promise');
  return mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USERNAME || 'root',
    password: process.env.MYSQL_TEST_PASSWORD || '',
    database
  });
}

async function login(base, username, password, returnTo = '/') {
  const page = await fetch(`${base}/login`);
  const preCookie = cookieFrom(page);
  const csrf = extractCsrf(await page.text());
  const response = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: preCookie },
    body: new URLSearchParams({ _csrf: csrf, username, password, returnTo }).toString()
  });
  return { response, cookie: cookieFrom(response) };
}

async function pageWithCsrf(base, pathname, cookie) {
  const response = await fetch(`${base}${pathname}`, { headers: { cookie } });
  const html = await response.text();
  return { response, html, csrf: extractCsrf(html) };
}

test('database users own isolated OAuth client profiles and sessions revoke on admin changes', { skip: !enabled }, async t => {
  const database = 'bot_report_user_test';
  const rootDatabase = process.env.MYSQL_TEST_DATABASE || 'bot_report_test';
  const root = await adminConnection(rootDatabase);
  await root.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await root.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.end();
  t.after(async () => {
    try {
      const admin = await adminConnection(rootDatabase);
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin.end();
    } catch (_) {}
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-report-user-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const appKey = crypto.createHash('sha256').update('user-account-integration-key').digest('base64');
  Object.assign(process.env, {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0',
    DATABASE_PATH: path.join(dir, 'missing.sqlite'),
    BOOTSTRAP_CONFIG_PATH: path.join(dir, 'bootstrap-config.json'),
    SESSION_SECRET: 'user-account-session-secret-that-is-long-enough-2026',
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'UserAdmin2026!',
    APP_ENCRYPTION_KEY: appKey, TERMINAL_CREDENTIAL_KEY: appKey,
    MCP_PUBLIC_BASE_URL: 'http://127.0.0.1:3333', MCP_ENABLED: 'true', LOGIN_RATE_LIMIT_MAX: '1000'
  });

  const bootstrapStore = require('../src/db/bootstrapConfigStore');
  bootstrapStore.save({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database,
    username: process.env.MYSQL_TEST_USERNAME || 'root',
    password: process.env.MYSQL_TEST_PASSWORD || '',
    ssl: false
  });

  const databaseManager = require('../src/db/databaseManager');
  const runtimeSettings = require('../src/services/runtimeSettingsService');
  databaseManager.resetForTests();
  runtimeSettings.resetForTests();
  await databaseManager.initialize();
  const prepared = await databaseManager.prepareSourceInitialization();
  await runtimeSettings.seedDefaults(prepared.adapter);
  await databaseManager.activatePrepared(prepared);
  await runtimeSettings.load(databaseManager.getAdapter());
  assert.equal(databaseManager.status().state, 'READY');

  const app = require('../src/app');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await databaseManager.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const adminLogin = await login(base, 'admin', 'UserAdmin2026!', '/admin/users');
  assert.equal(adminLogin.response.status, 302);
  assert.equal(adminLogin.response.headers.get('location'), '/admin/users');
  const adminUsers = await pageWithCsrf(base, '/admin/users', adminLogin.cookie);
  assert.equal(adminUsers.response.status, 200);
  assert.match(adminUsers.html, /New User/);
  assert.ok(adminUsers.csrf);

  for (const user of [
    { username: 'alice', display_name: 'Alice', email: 'alice@example.test', password: 'AlicePassword2026!' },
    { username: 'bob', display_name: 'Bob', email: 'bob@example.test', password: 'BobPassword2026!' }
  ]) {
    const created = await fetch(`${base}/admin/users`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminLogin.cookie },
      body: new URLSearchParams({ _csrf: adminUsers.csrf, ...user }).toString()
    });
    assert.equal(created.status, 302);
    assert.equal(created.headers.get('location'), '/admin/users');
  }

  const userRepo = require('../src/repositories/userRepository');
  const oauthRepo = require('../src/repositories/mcpOAuthRepository');
  const users = await userRepo.list();
  const alice = users.find(user => user.username === 'alice');
  const bob = users.find(user => user.username === 'bob');
  assert.ok(alice && bob);
  assert.notEqual(alice.principal_id, bob.principal_id);
  assert.notEqual(alice.profile_id, bob.profile_id);
  assert.match(alice.principal_id, /^principal:user:usr_/);
  assert.match(alice.profile_id, /^profile:user:usr_/);

  const aliceLogin = await login(base, 'alice', 'AlicePassword2026!');
  assert.equal(aliceLogin.response.status, 302);
  assert.equal(aliceLogin.response.headers.get('location'), '/account/clients');
  const aliceClientsPage = await pageWithCsrf(base, '/account/clients', aliceLogin.cookie);
  assert.equal(aliceClientsPage.response.status, 200);
  assert.match(aliceClientsPage.html, /My Clients/);
  assert.match(aliceClientsPage.html, /Client Profile/);
  assert.match(aliceClientsPage.html, />Workers</);
  assert.doesNotMatch(aliceClientsPage.html, />Settings</);

  const createAliceClient = await fetch(`${base}/account/clients`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: aliceLogin.cookie },
    body: new URLSearchParams({
      _csrf: aliceClientsPage.csrf,
      display_name: 'Alice ChatGPT',
      redirect_uris: 'https://chatgpt.com/connector_platform_oauth_redirect',
      scopes: 'bot_report.terminal'
    }).toString()
  });
  assert.equal(createAliceClient.status, 302);
  const aliceClients = await oauthRepo.listClientsByOwner(alice.id);
  assert.equal(aliceClients.length, 1);
  assert.equal(aliceClients[0].owner_user_id, alice.id);
  assert.equal(aliceClients[0].principal_id, alice.principal_id);
  assert.equal(aliceClients[0].profile_id, alice.profile_id);
  assert.deepEqual(aliceClients[0].allowed_scopes.sort(), ['bot_report.read', 'bot_report.terminal', 'offline_access'].sort());

  const workerRepo = require('../src/repositories/workerRepository');
  const aliceWorkersPage = await pageWithCsrf(base, '/account/workers', aliceLogin.cookie);
  assert.equal(aliceWorkersPage.response.status, 200);
  assert.match(aliceWorkersPage.html, /Generate Enrollment Token/);
  const createEnrollment = await fetch(`${base}/account/workers/enrollment`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: aliceLogin.cookie },
    body: new URLSearchParams({ _csrf: aliceWorkersPage.csrf, ttl_seconds: '600' }).toString()
  });
  assert.equal(createEnrollment.status, 302);
  const enrollmentPage = await pageWithCsrf(base, '/account/workers', aliceLogin.cookie);
  const enrollmentToken = enrollmentPage.html.match(/br_enroll_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(enrollmentToken);
  const identity = crypto.generateKeyPairSync('ed25519');
  const publicKey = identity.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const enrollWorker = await fetch(`${base}/worker/v1/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: enrollmentToken,
      name: 'Alice Worker',
      public_key: publicKey,
      capabilities: ['workspace.exec', 'tmux.inspect'],
      create_profile: true,
      profile_name: 'Alice Worker',
      tmux_session: 'main'
    })
  });
  assert.equal(enrollWorker.status, 201);
  const enrolled = await enrollWorker.json();
  assert.equal((await workerRepo.listWorkersByOwner(alice.id)).length, 1);
  assert.equal((await workerRepo.listWorkersByOwner(bob.id)).length, 0);
  assert.equal((await workerRepo.listProfilesByOwner(alice.id))[0].name, enrolled.profile.name);

  const globalWorker = await workerRepo.createWorker({ name: 'Admin Global Worker', publicKey: 'test-key', capabilities: [] });
  await workerRepo.createProfile({ name: 'Admin Global Profile', workerId: globalWorker.id, tmuxSession: 'main', enabled: true });
  const terminalMcpService = require('../src/services/terminalMcpService');
  assert.deepEqual((await terminalMcpService.list({ actorId: alice.principal_id })).map(item => item.name), [enrolled.profile.name]);
  assert.deepEqual(await terminalMcpService.list({ actorId: bob.principal_id }), []);
  await assert.rejects(() => terminalMcpService.findProfile('Admin Global Profile', { actorId: alice.principal_id }), error => error.code === 'PROFILE_NOT_FOUND');

  const bobWorkersPageBeforeEnroll = await pageWithCsrf(base, '/account/workers', (await login(base, 'bob', 'BobPassword2026!')).cookie);
  assert.doesNotMatch(bobWorkersPageBeforeEnroll.html, /Alice Worker/);

  const rawAccessToken = 'br_at_user_owner_status_integration';
  await oauthRepo.createAccessToken({
    tokenHash: crypto.createHash('sha256').update(rawAccessToken).digest('hex'),
    clientId: aliceClients[0].client_id,
    principalId: alice.principal_id,
    resource: 'http://127.0.0.1:3333/mcp',
    scopes: ['bot_report.read', 'bot_report.terminal'],
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const { OAuthResourceServer } = require('../src/auth/oauthResourceServer');
  const resourceServer = new OAuthResourceServer({ repo: oauthRepo, allowTestFixtures: false });
  const alicePrincipal = await resourceServer.verifyToken(rawAccessToken);
  assert.equal(alicePrincipal.principal_id, alice.principal_id);
  assert.equal(alicePrincipal.owner_user_id, alice.id);

  const bobLogin = await login(base, 'bob', 'BobPassword2026!');
  assert.equal(bobLogin.response.status, 302);
  const bobClientsPage = await pageWithCsrf(base, '/account/clients', bobLogin.cookie);
  const createBobClient = await fetch(`${base}/account/clients`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: bobLogin.cookie },
    body: new URLSearchParams({ _csrf: bobClientsPage.csrf, display_name: 'Bob Client', redirect_uris: 'https://example.test/oauth/callback' }).toString()
  });
  assert.equal(createBobClient.status, 302);
  const bobClient = (await oauthRepo.listClientsByOwner(bob.id))[0];
  assert.ok(bobClient);

  const crossAction = await fetch(`${base}/account/clients/${bobClient.id}/disable`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: aliceLogin.cookie },
    body: new URLSearchParams({ _csrf: aliceClientsPage.csrf }).toString()
  });
  assert.equal(crossAction.status, 404);

  const verifier = 'user-account-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorizeParams = client => new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: 'code',
    scope: 'bot_report.read',
    state: 'state-user-test',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: 'http://127.0.0.1:3333/mcp'
  });
  const ownConsent = await fetch(`${base}/oauth/authorize?${authorizeParams(aliceClients[0])}`, { headers: { cookie: aliceLogin.cookie } });
  assert.equal(ownConsent.status, 200);
  assert.match(await ownConsent.text(), /Authorize access/);
  const crossConsent = await fetch(`${base}/oauth/authorize?${authorizeParams(bobClient)}`, { headers: { cookie: aliceLogin.cookie } });
  assert.equal(crossConsent.status, 403);
  const adminCannotImpersonate = await fetch(`${base}/oauth/authorize?${authorizeParams(aliceClients[0])}`, { headers: { cookie: adminLogin.cookie } });
  assert.equal(adminCannotImpersonate.status, 403);

  const aliceWorker = (await workerRepo.listWorkersByOwner(alice.id))[0];
  assert.ok(aliceWorker);
  const bobCannotRemoveAliceWorker = await fetch(`${base}/account/workers/${aliceWorker.id}/remove`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: bobLogin.cookie },
    body: new URLSearchParams({ _csrf: bobClientsPage.csrf }).toString()
  });
  assert.equal(bobCannotRemoveAliceWorker.status, 404);
  assert.equal((await workerRepo.listWorkersByOwner(alice.id)).length, 1);

  const aliceRemovesOwnWorker = await fetch(`${base}/account/workers/${aliceWorker.id}/remove`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: aliceLogin.cookie },
    body: new URLSearchParams({ _csrf: aliceWorkersPage.csrf }).toString()
  });
  assert.equal(aliceRemovesOwnWorker.status, 302);
  // Offline Workers cannot acknowledge remote uninstall; preserve their record.
  assert.equal((await workerRepo.listWorkersByOwner(alice.id)).length, 1);
  const bobCannotForceRemoveAliceWorker = await fetch(`${base}/account/workers/${aliceWorker.id}/force-remove`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: bobLogin.cookie },
    body: new URLSearchParams({ _csrf: bobClientsPage.csrf }).toString()
  });
  assert.equal(bobCannotForceRemoveAliceWorker.status, 404);
  const aliceForceRemovesOwnWorker = await fetch(`${base}/account/workers/${aliceWorker.id}/force-remove`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: aliceLogin.cookie },
    body: new URLSearchParams({ _csrf: aliceWorkersPage.csrf }).toString()
  });
  assert.equal(aliceForceRemovesOwnWorker.status, 302);
  assert.equal((await workerRepo.listWorkersByOwner(alice.id)).length, 0);
  assert.equal((await workerRepo.listProfilesByOwner(alice.id)).length, 0);
  assert.ok(await workerRepo.findWorkerById(globalWorker.id));

  const disableAlice = await fetch(`${base}/admin/users/${alice.id}/disable`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminLogin.cookie },
    body: new URLSearchParams({ _csrf: adminUsers.csrf }).toString()
  });
  assert.equal(disableAlice.status, 302);
  const revokedSession = await fetch(`${base}/account/clients`, { redirect: 'manual', headers: { cookie: aliceLogin.cookie } });
  assert.equal(revokedSession.status, 302);
  assert.match(revokedSession.headers.get('location') || '', /^\/login/);
  const oauthService = require('../src/services/mcpOAuthService');
  await assert.rejects(() => oauthService.validateAuthorizeRequest({
    clientId: aliceClients[0].client_id,
    redirectUri: aliceClients[0].redirect_uris[0],
    responseType: 'code',
    scope: 'bot_report.read',
    state: 'disabled-user',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    resource: 'http://127.0.0.1:3333/mcp'
  }), error => error.error === 'unauthorized_client' && /disabled/i.test(error.message));
  await assert.rejects(() => resourceServer.verifyToken(rawAccessToken), error => error.code === 'USER_DISABLED');

  const enableAlice = await fetch(`${base}/admin/users/${alice.id}/enable`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminLogin.cookie },
    body: new URLSearchParams({ _csrf: adminUsers.csrf }).toString()
  });
  assert.equal(enableAlice.status, 302);
  const resetAlice = await fetch(`${base}/admin/users/${alice.id}/reset-password`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminLogin.cookie },
    body: new URLSearchParams({ _csrf: adminUsers.csrf, password: 'AlicePasswordReset2026!' }).toString()
  });
  assert.equal(resetAlice.status, 302);
  assert.equal((await login(base, 'alice', 'AlicePassword2026!')).response.status, 401);
  const aliceRelogin = await login(base, 'alice', 'AlicePasswordReset2026!');
  assert.equal(aliceRelogin.response.status, 302);
  assert.equal(aliceRelogin.response.headers.get('location'), '/account/clients');
});
