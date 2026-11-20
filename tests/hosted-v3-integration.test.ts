import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const csrfFrom = (html: string) => html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
const cookieFrom = (response: Response) => (response.headers.get('set-cookie') || '').split(';')[0];
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';

void test('hosted v3: registration, admin approval, public OAuth PKCE, two-user isolation and revocation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-worker-hosted-v3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = crypto.createHash('sha256').update('hosted-v3-test-key').digest('base64');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_PATH: path.join(dir, 'app.sqlite'),
    BOOTSTRAP_CONFIG_PATH: path.join(dir, 'bootstrap.json'),
    SESSION_SECRET: 'test-hosted-v3-secret-long-enough-do-not-use-prod',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'V3AdminPassword2026!',
    APP_ENCRYPTION_KEY: key,
    TERMINAL_CREDENTIAL_KEY: key,
    MCP_PUBLIC_BASE_URL: 'http://127.0.0.1:3333',
    MCP_ENABLED: 'true',
    LOGIN_RATE_LIMIT_MAX: '1000',
  });
  const databaseManager = (await import('../src/db/databaseManager.js')).default;
  const runtimeSettings = (await import('../src/services/runtimeSettingsService.js')).default;
  databaseManager.resetForTests();
  runtimeSettings.resetForTests();
  const { runMigrations } = await import('../src/db/migrations.js');
  runMigrations();
  await databaseManager.initialize();
  await runtimeSettings.seedDefaults(databaseManager.getAdapter());
  const { getDb } = await import('../src/db/connection.js');
  const schema = getDb().prepare('PRAGMA table_info(users)').all() as {
    name: string;
    dflt_value: string | null;
  }[];
  assert.equal(schema.find((c) => c.name === 'role')?.dflt_value, "'user'");

  const app = (await import('../src/app.js')).default;
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await databaseManager.close();
  });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  async function page(uri: string, cookie = '') {
    const response = await fetch(base + uri, { headers: cookie ? { cookie } : {} });
    const html = await response.text();
    return { response, html, csrf: csrfFrom(html), cookie: cookie || cookieFrom(response) };
  }
  async function post(uri: string, values: Record<string, string>, cookie = '') {
    return fetch(base + uri, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams(values).toString(),
    });
  }
  async function login(name: string, password: string) {
    const p = await page('/login');
    return post('/login', { _csrf: p.csrf, username: name, password }, p.cookie);
  }
  const adminLogin = await login('admin', 'V3AdminPassword2026!');
  assert.equal(adminLogin.status, 302);
  const adminCookie = cookieFrom(adminLogin);
  const adminUsers = await page('/admin/users', adminCookie);
  assert.equal(adminUsers.response.status, 200);
  assert.match(adminUsers.html, /Allow public registration/);

  const close = await post('/admin/registration', { _csrf: adminUsers.csrf }, adminCookie);
  assert.equal(close.status, 303);
  assert.equal((await page('/register')).response.status, 200);
  assert.doesNotMatch((await page('/register')).html, /name="username"/);
  const reopen = await post(
    '/admin/registration',
    { _csrf: adminUsers.csrf, enabled: 'true' },
    adminCookie,
  );
  assert.equal(reopen.status, 303);

  async function register(username: string, password: string) {
    const p = await page('/register');
    assert.ok(p.csrf);
    const result = await post(
      '/register',
      {
        _csrf: p.csrf,
        username,
        email: username + '@example.test',
        display_name: username,
        password,
      },
      p.cookie,
    );
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('location'), '/registration-pending');
  }
  await register('alice', 'AliceSecret2026!');
  const pendingLogin = await login('alice', 'AliceSecret2026!');
  assert.equal(pendingLogin.status, 401);
  const userRepo = (await import('../src/repositories/userRepository.js')).default;
  const userService = (await import('../src/services/userService.js')).default;
  const alice = await userRepo.findByUsername('alice');
  assert.ok(alice);
  assert.equal(alice.status, 'pending');
  assert.equal(alice.role, 'user');
  const approveAlice = await post(
    '/admin/users/' + alice.id + '/approve',
    { _csrf: adminUsers.csrf },
    adminCookie,
  );
  assert.equal(approveAlice.status, 303);
  const aliceLogin = await login('alice', 'AliceSecret2026!');
  assert.equal(aliceLogin.status, 302);
  assert.equal(aliceLogin.headers.get('location'), '/account');
  const aliceCookie = cookieFrom(aliceLogin);
  assert.match((await page('/account', aliceCookie)).html, /Connect ChatGPT/);
  const nonAdmin = await fetch(base + '/admin/users', {
    headers: { cookie: aliceCookie },
    redirect: 'manual',
  });
  assert.equal(nonAdmin.status, 302);
  assert.match(String(nonAdmin.headers.get('location')), /^\/login/);

  await register('bob', 'BobSecret2026!');
  const bob = await userRepo.findByUsername('bob');
  assert.ok(bob);
  assert.equal(
    (await post('/admin/users/' + bob.id + '/approve', { _csrf: adminUsers.csrf }, adminCookie))
      .status,
    303,
  );
  const bobCookie = cookieFrom(await login('bob', 'BobSecret2026!'));

  const discovery = await fetch(base + '/.well-known/oauth-authorization-server');
  assert.equal(discovery.status, 200);
  const metadata = (await discovery.json()) as Record<string, unknown>;
  assert.equal(metadata.registration_endpoint, 'http://127.0.0.1:3333/oauth/register');
  assert.ok((metadata.token_endpoint_auth_methods_supported as string[]).includes('none'));
  const invalidDcr = await fetch(base + '/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Unsafe',
      redirect_uris: ['http://attacker.example/callback'],
    }),
  });
  assert.equal(invalidDcr.status, 400);
  const registered = await fetch(base + '/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT hosted',
      redirect_uris: [redirect],
      scope: 'mcp_worker.read offline_access',
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registered.status, 201);
  const dcr = (await registered.json()) as { client_id: string; client_secret?: string };
  assert.match(dcr.client_id, /^br_public_/);
  assert.equal(dcr.client_secret, undefined);
  const oauthRepo = (await import('../src/repositories/mcpOAuthRepository.js')).default;
  const savedClient = await oauthRepo.findClientByClientId(dcr.client_id);
  assert.equal(savedClient?.is_public, 1);

  const verifier = 'z'.repeat(64);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const resource = 'http://127.0.0.1:3333/mcp';
  async function tokensFor(cookie: string) {
    const params = {
      client_id: dcr.client_id,
      redirect_uri: redirect,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
      scope: 'mcp_worker.read offline_access',
      state: 'csrf-test-state',
    };
    const consent = await page('/oauth/authorize?' + new URLSearchParams(params).toString(), cookie);
    assert.equal(consent.response.status, 200);
    assert.match(consent.html, /Authorize access/);
    const authorized = await post(
      '/oauth/authorize',
      {
        ...params,
        _csrf: consent.csrf,
        action: 'allow',
      },
      cookie,
    );
    assert.equal(authorized.status, 302);
    const url = new URL(String(authorized.headers.get('location')));
    assert.equal(url.searchParams.get('state'), 'csrf-test-state');
    const code = url.searchParams.get('code');
    assert.ok(code);
    const result = await post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: dcr.client_id,
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    });
    assert.equal(result.status, 200, await result.clone().text());
    return result.json() as Promise<{ access_token: string; refresh_token: string; scope: string }>;
  }
  const aliceTokens = await tokensFor(aliceCookie);
  const bobTokens = await tokensFor(bobCookie);
  const { OAuthResourceServer } = (await import('../src/auth/oauthResourceServer.js')).default;
  const resourceServer = new OAuthResourceServer({ repo: oauthRepo, allowTestFixtures: false });
  const alicePrincipal = await resourceServer.verifyToken(aliceTokens.access_token);
  const bobPrincipal = await resourceServer.verifyToken(bobTokens.access_token);
  assert.equal(alicePrincipal.owner_user_id, alice.id);
  assert.equal(bobPrincipal.owner_user_id, bob.id);
  assert.equal(alicePrincipal.principal_id, alice.principal_id);
  assert.equal(bobPrincipal.principal_id, bob.principal_id);
  assert.notEqual(aliceTokens.access_token, bobTokens.access_token);
  assert.equal(alicePrincipal.hasScope('mcp_worker.terminal'), false);
  assert.equal(bobPrincipal.hasScope('mcp_worker.terminal'), false);
  const { runWithPrincipal } = await import('../src/mcp/context.js');
  const { AuthenticatedPrincipal } = await import('../src/auth/principal.js');
  const { listTerminals } = await import('../src/mcp/tools/terminalTools.js');
  const forgedTerminalGrant = new AuthenticatedPrincipal({
    principalId: alice.principal_id,
    ownerUserId: alice.id,
    actorId: alice.principal_id,
    scopes: ['mcp_worker.read', 'mcp_worker.terminal'],
  });
  // Listing owner-scoped Workers is harmless; each executable target still needs
  // an explicit Personal mode or verified Hosted attestation.
  const ownedList = await runWithPrincipal(forgedTerminalGrant, () => listTerminals.handler({}));
  assert.deepEqual((ownedList.structuredContent as { terminals: unknown[] }).terminals, []);

  const workerRepo = (await import('../src/repositories/workerRepository.js')).default;
  const untrustedWorker = await workerRepo.createWorker({
    name: 'BYO Alice Worker',
    publicKey: 'test-only',
    capabilities: [],
    ownerUserId: alice.id,
  });
  assert.ok(untrustedWorker);
  await workerRepo.createProfile(
    { name: 'alice-untrusted', workerId: untrustedWorker.id, enabled: true },
    { ownerUserId: alice.id },
  );
  const policyEnabled = await post(
    '/admin/hosted',
    { _csrf: adminUsers.csrf, enabled: 'true' },
    adminCookie,
  );
  assert.equal(policyEnabled.status, 303);
  const terminalService = (await import('../src/services/terminalMcpService.js')).default;
  await assert.rejects(
    () => terminalService.findProfile('alice-untrusted', { actorId: alice.principal_id }),
    (e: unknown) => e instanceof Error && 'code' in e && e.code === 'HOSTED_EXECUTION_DISABLED',
  );
  assert.equal((await post('/admin/hosted', { _csrf: adminUsers.csrf }, adminCookie)).status, 303);

  const refresh = await post('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: dcr.client_id,
    refresh_token: aliceTokens.refresh_token,
    resource,
  });
  assert.equal(refresh.status, 200, await refresh.clone().text());
  const rotated = (await refresh.json()) as { access_token: string; refresh_token: string };
  assert.equal((await resourceServer.verifyToken(rotated.access_token)).owner_user_id, alice.id);
  assert.notEqual(rotated.refresh_token, aliceTokens.refresh_token);

  await oauthRepo.recordAudit({
    requestId: 'alice-only',
    clientId: dcr.client_id,
    principalId: alice.principal_id,
    mcpMethod: 'tools/call',
    toolName: 'ALICE_PRIVATE_EVENT',
    result: 'SUCCESS',
    httpStatus: 200,
    durationMs: 1,
  });
  await oauthRepo.recordAudit({
    requestId: 'bob-only',
    clientId: dcr.client_id,
    principalId: bob.principal_id,
    mcpMethod: 'tools/call',
    toolName: 'BOB_PRIVATE_EVENT',
    result: 'SUCCESS',
    httpStatus: 200,
    durationMs: 1,
  });
  const aliceActivity = await page('/account/activity', aliceCookie);
  const bobActivity = await page('/account/activity', bobCookie);
  assert.match(aliceActivity.html, /ALICE_PRIVATE_EVENT/);
  assert.doesNotMatch(aliceActivity.html, /BOB_PRIVATE_EVENT/);
  assert.match(bobActivity.html, /BOB_PRIVATE_EVENT/);
  assert.doesNotMatch(bobActivity.html, /ALICE_PRIVATE_EVENT/);

  const disable = await post(
    '/admin/users/' + alice.id + '/disable',
    { _csrf: adminUsers.csrf },
    adminCookie,
  );
  assert.equal(disable.status, 303);
  await assert.rejects(resourceServer.verifyToken(rotated.access_token), /revoked|disabled/);
  assert.equal((await login('alice', 'AliceSecret2026!')).status, 401);
  assert.equal((await resourceServer.verifyToken(bobTokens.access_token)).owner_user_id, bob.id);
  const deniedRefresh = await post('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: dcr.client_id,
    refresh_token: rotated.refresh_token,
    resource,
  });
  assert.equal(deniedRefresh.status, 400);
  assert.equal(
    await userService.currentFromSession({
      role: 'user',
      userId: alice.id,
      sessionVersion: alice.session_version,
    }),
    null,
  );
  assert.equal(
    (await post('/admin/users/' + alice.id + '/enable', { _csrf: adminUsers.csrf }, adminCookie))
      .status,
    303,
  );
  await assert.rejects(resourceServer.verifyToken(rotated.access_token), /revoked/);
  assert.equal((await resourceServer.verifyToken(bobTokens.access_token)).owner_user_id, bob.id);
});
