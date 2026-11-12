import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

function cookie(response: Response) {
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

function csrf(html: string) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
}

void test('Railway SQLite volume survives restart and locks owner setup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-railway-sqlite-'));
  const keys = [
    'MCP_PLATFORM',
    'MCP_SETUP_SECRET',
    'RAILWAY_VOLUME_MOUNT_PATH',
    'RAILWAY_PUBLIC_DOMAIN',
    'MCP_PUBLIC_BASE_URL',
    'DATABASE_PATH',
    'TRUST_PROXY',
    'NODE_ENV',
  ] as const;
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.MCP_PLATFORM = 'railway';
  process.env.MCP_SETUP_SECRET = crypto.randomBytes(32).toString('base64url');
  process.env.RAILWAY_VOLUME_MOUNT_PATH = root;
  process.env.RAILWAY_PUBLIC_DOMAIN = 'private-railway.up.railway.app';
  delete process.env.MCP_PUBLIC_BASE_URL;
  process.env.DATABASE_PATH = path.join(root, 'bot_report.sqlite');
  process.env.TRUST_PROXY = '1';
  process.env.NODE_ENV = 'test';

  let server: http.Server | null = null;
  try {
    const manager = (await import('../src/db/databaseManager.js')).default;
    const connection = await import('../src/db/connection.js');
    const settings = (await import('../src/services/runtimeSettingsService.js')).default;
    const oauth = (await import('../src/config/mcpConfig.js')).default;
    const key = await import('../src/services/applicationKeyService.js');
    await manager.initialize();
    assert.equal(manager.isRailwaySqliteReady(), true);
    assert.equal(manager.status().engine, 'sqlite');
    await settings.seedDefaults(manager.getAdapter());
    assert.equal(oauth.issuer, 'https://private-railway.up.railway.app');
    const firstKey = key.readKey();
    assert.equal(firstKey.length, 32);

    const app = (await import('../src/app.js')).default;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const base = 'http://127.0.0.1:' + address.port;
    const headers = { 'x-forwarded-proto': 'https' };
    const initial = await fetch(base + '/setup', { headers, redirect: 'manual' });
    assert.equal(initial.status, 200);
    const firstCookie = cookie(initial);
    const token = csrf(await initial.text());
    assert.ok(token && firstCookie, 'CSRF form and signed SQLite session are required');

    const submit = (setupKey: string) =>
      fetch(base + '/setup', {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...headers,
          cookie: firstCookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          _csrf: token,
          setup_key: setupKey,
          password: 'PrivateRailwayAdmin2026!',
          confirm_password: 'PrivateRailwayAdmin2026!',
        }).toString(),
      });
    const denied = await submit('A'.repeat(43));
    assert.equal(denied.status, 403);
    const created = await submit(process.env.MCP_SETUP_SECRET);
    assert.equal(created.status, 303);
    assert.equal(created.headers.get('location'), '/login');
    assert.equal((await submit(process.env.MCP_SETUP_SECRET)).status, 409);
    assert.equal((await fetch(base + '/setup', { headers, redirect: 'manual' })).status, 302);
    assert.equal((await fetch(base + '/readyz', { headers })).status, 200);
    const unsignedInstaller = await fetch(base + '/worker/install.sh', { headers });
    assert.equal(unsignedInstaller.status, 503);
    const unsignedBody = (await unsignedInstaller.json()) as { code: string };
    assert.equal(unsignedBody.code, 'WORKER_SIGNED_RELEASE_PENDING');
    const discovery = await fetch(base + '/.well-known/oauth-authorization-server', {
      headers,
    });
    assert.equal(discovery.status, 200);
    const metadata = (await discovery.json()) as {
      issuer: string;
      token_endpoint: string;
    };
    assert.equal(metadata.issuer, 'https://private-railway.up.railway.app');
    assert.equal(metadata.token_endpoint, metadata.issuer + '/oauth/token');

    // Use the actual Railway SQLite HTTP login, OAuth consent and PKCE grant,
    // not a mocked repository or the MySQL compatibility fixture.
    const loginPage = await fetch(base + '/login', { headers, redirect: 'manual' });
    assert.equal(loginPage.status, 200);
    const loginCookie = cookie(loginPage);
    const loginCsrf = csrf(await loginPage.text());
    assert.ok(loginCookie && loginCsrf);
    const signedIn = await fetch(base + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...headers,
        cookie: loginCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        _csrf: loginCsrf,
        username: 'admin',
        password: 'PrivateRailwayAdmin2026!',
        returnTo: '/',
      }).toString(),
    });
    assert.equal(signedIn.status, 302);
    const authenticatedCookie = cookie(signedIn);
    assert.ok(authenticatedCookie);

    const oauthService = (await import('../src/services/mcpOAuthService.js')).default;
    const registered = await oauthService.registerClient({
      displayName: 'Railway PKCE Client',
      principalId: 'principal:railway_quickstart',
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      allowedScopes: ['bot_report.read', 'bot_report.terminal'],
    });
    assert.ok(registered.client);
    assert.ok(registered.rawSecret);
    const verifier = 'railway-pkce-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const params = new URLSearchParams({
      client_id: registered.client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'bot_report.read bot_report.terminal',
      state: 'railway-oauth-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: oauth.resourceUrl,
    });
    const consent = await fetch(base + '/oauth/authorize?' + params.toString(), {
      headers: { ...headers, cookie: authenticatedCookie },
      redirect: 'manual',
    });
    assert.equal(consent.status, 200);
    const consentToken = csrf(await consent.text());
    assert.ok(consentToken);
    const consentBody = new URLSearchParams(params);
    consentBody.set('_csrf', consentToken);
    consentBody.set('action', 'allow');
    const allowed = await fetch(base + '/oauth/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...headers,
        cookie: authenticatedCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: consentBody.toString(),
    });
    assert.equal(allowed.status, 302);
    const redirected = new URL(allowed.headers.get('location') || '');
    assert.equal(redirected.origin, 'https://chatgpt.com');
    assert.equal(redirected.searchParams.get('state'), 'railway-oauth-state');
    const authorizationCode = redirected.searchParams.get('code');
    assert.ok(authorizationCode);
    const grant = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: redirectUri,
      resource: oauth.resourceUrl,
      code_verifier: verifier,
    });
    const tokenHeaders = {
      ...headers,
      'content-type': 'application/x-www-form-urlencoded',
      authorization:
        'Basic ' +
        Buffer.from([registered.client.client_id, registered.rawSecret].join(':')).toString('base64'),
    };
    const granted = await fetch(base + '/oauth/token', {
      method: 'POST',
      headers: tokenHeaders,
      body: grant.toString(),
    });
    assert.equal(granted.status, 200);
    const grantBody = (await granted.json()) as { access_token: string };
    assert.match(grantBody.access_token, /^br_at_/);
    const replay = await fetch(base + '/oauth/token', {
      method: 'POST',
      headers: tokenHeaders,
      body: grant.toString(),
    });
    assert.equal(replay.status, 400, 'Authorization code must be single-use');

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    await manager.close();
    connection.closeDb();
    manager.resetForTests();
    await manager.initialize();
    assert.equal(manager.isRailwaySqliteReady(), true);
    assert.deepEqual(key.readKey(), firstKey);
    const db = connection.getDb();
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(
      await (await import('../src/routes/railwaySetupRoutes.js')).default.isOwnerSetupComplete(),
      true,
    );
    const session = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number;
    };
    assert.ok(session.count > 0, 'Admin setup session must survive process restart');
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    try {
      const manager = (await import('../src/db/databaseManager.js')).default;
      await manager.close();
      manager.resetForTests();
      const conn = await import('../src/db/connection.js');
      conn.closeDb();
    } catch {}
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test('Railway refuses ephemeral storage and forged canonical hosts', async () => {
  const config = (await import('../src/config/railwayOrigin.js')).canonicalRailwayOrigin;
  assert.equal(
    config({ RAILWAY_PUBLIC_DOMAIN: 'owner.up.railway.app' }),
    'https://owner.up.railway.app',
  );
  assert.equal(config({}), null);
  assert.throws(() => config({ RAILWAY_PUBLIC_DOMAIN: 'attacker.example' }), /Railway domain/);
  assert.throws(
    () => config({ MCP_PUBLIC_BASE_URL: 'https://user:pass@owner.example' }),
    /Invalid/,
  );
});
