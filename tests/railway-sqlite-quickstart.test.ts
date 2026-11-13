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
    const gated = await fetch(base + '/admin', { headers, redirect: 'manual' });
    assert.equal(gated.status, 302, 'Admin must be inaccessible before owner claim');
    assert.equal(gated.headers.get('location'), '/setup');
    const initial = await fetch(base + '/setup', { headers, redirect: 'manual' });
    assert.equal(initial.status, 200);
    const firstCookie = cookie(initial);
    const setupPage = await initial.text();
    const token = csrf(setupPage);
    assert.ok(token && firstCookie, 'CSRF form and signed SQLite session are required');
    assert.match(setupPage, /Step 1 of 6: Create your Admin/);
    assert.match(setupPage, /signed Worker release approval is pending/);
    assert.doesNotMatch(setupPage, new RegExp(process.env.MCP_SETUP_SECRET || 'never-matches'));
    assert.equal(initial.headers.get('referrer-policy'), 'no-referrer');

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
    const invalidCsrf = await fetch(base + '/setup', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...headers,
        cookie: firstCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        _csrf: 'invalid',
        setup_key: process.env.MCP_SETUP_SECRET || '',
        password: 'PrivateRailwayAdmin2026!',
        confirm_password: 'PrivateRailwayAdmin2026!',
      }).toString(),
    });
    assert.equal(invalidCsrf.status, 403);
    const denied = await submit('A'.repeat(43));
    assert.equal(denied.status, 403);
    const shortPassword = await fetch(base + '/setup', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...headers,
        cookie: firstCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        _csrf: token,
        setup_key: process.env.MCP_SETUP_SECRET || '',
        password: 'too-short',
        confirm_password: 'too-short',
      }).toString(),
    });
    assert.equal(shortPassword.status, 403);
    const rivalPage = await fetch(base + '/setup', { headers, redirect: 'manual' });
    const rivalCookie = cookie(rivalPage);
    const rivalCsrf = csrf(await rivalPage.text());
    assert.ok(rivalCookie && rivalCsrf);
    const rivalClaim = () =>
      fetch(base + '/setup', {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...headers,
          cookie: rivalCookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          _csrf: rivalCsrf,
          setup_key: process.env.MCP_SETUP_SECRET || '',
          password: 'PrivateRailwayAdmin2026!',
          confirm_password: 'PrivateRailwayAdmin2026!',
        }).toString(),
      });
    const claims = await Promise.all([submit(process.env.MCP_SETUP_SECRET || ''), rivalClaim()]);
    assert.deepEqual(
      claims.map((response) => response.status).sort(),
      [303, 409],
      'Only one of two concurrent first-owner claims may succeed',
    );
    const created = claims.find((response) => response.status === 303);
    assert.equal(created?.headers.get('location'), '/login');
    const winnerCookie = claims[0].status === 303 ? firstCookie : rivalCookie;
    const afterClaimLogin = await fetch(base + '/login', {
      headers: { ...headers, cookie: winnerCookie },
    });
    assert.match(await afterClaimLogin.text(), /name="returnTo" value="\/admin\/onboarding"/);
    assert.equal((await submit(process.env.MCP_SETUP_SECRET || '')).status, 409);
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
    assert.notEqual(authenticatedCookie, loginCookie, 'Login must regenerate the session ID');
    const guestGuide = await fetch(base + '/admin/onboarding', { headers, redirect: 'manual' });
    assert.equal(guestGuide.status, 302, 'Onboarding status is private to an Admin session');
    const guideResponse = await fetch(base + '/admin/onboarding', {
      headers: { ...headers, cookie: authenticatedCookie },
    });
    assert.equal(guideResponse.status, 200);
    assert.equal(guideResponse.headers.get('cache-control'), 'no-store');
    const guide = await guideResponse.text();
    assert.match(guide, /data-onboarding-status="blocked"/);
    assert.match(guide, /data-chatgpt-verification="unverified"/);
    assert.doesNotMatch(guide, /data-onboarding-status="done"/);
    assert.match(guide, /data-onboarding-step="4" data-complete="false" data-state="blocked"/);
    assert.match(guide, /WORKER_SIGNED_RELEASE_PENDING/);
    assert.match(guide, /Connect ChatGPT \(manual\)/);
    assert.match(guide, /Copy endpoint/);
    assert.doesNotMatch(guide, /All six steps complete/);
    assert.doesNotMatch(guide, new RegExp(process.env.MCP_SETUP_SECRET || 'never-matches'));
    const headInstaller = await fetch(base + '/worker/install.sh', {
      method: 'HEAD',
      headers,
    });
    assert.equal(
      headInstaller.status,
      503,
      'Browser probe must see the actual signed release gate',
    );
    // No native-platform or manifest endpoint may bypass the shared Railway
    // release blocker. A healthy server (readyz=200) cannot approve binaries.
    for (const route of [
      '/worker/install-linux.sh',
      '/worker/install-macos.sh',
      '/worker/install-windows.ps1',
      '/worker/dist/WORKER_RELEASE',
      '/worker/dist/SHA256SUMS',
      '/worker/dist/SHA256SUMS.sig',
    ]) {
      const blocked = await fetch(base + route, { method: 'HEAD', headers });
      assert.equal(blocked.status, 503, route + ' must fail closed before release approval');
    }
    const firstClientPage = await fetch(base + '/admin/clients?first_call=1', {
      headers: { ...headers, cookie: authenticatedCookie },
    });
    assert.equal(firstClientPage.status, 200);
    const firstClientHtml = await firstClientPage.text();
    assert.match(firstClientHtml, /name="display_name" value="ChatGPT"/);
    assert.match(firstClientHtml, /https:\/\/chatgpt\.com\/connector_platform_oauth_redirect/);
    assert.match(firstClientHtml, /name="scopes" value="bot_report.read" checked/);
    assert.doesNotMatch(firstClientHtml, /name="scopes" value="bot_report.terminal" checked/);
    assert.doesNotMatch(firstClientHtml, /name="scopes" value="offline_access" checked/);
    const ordinaryClients = await fetch(base + '/admin/clients', {
      headers: { ...headers, cookie: authenticatedCookie },
    });
    const ordinaryHtml = await ordinaryClients.text();
    assert.match(ordinaryHtml, /name="scopes" value="bot_report.read" checked/);
    assert.doesNotMatch(ordinaryHtml, /name="scopes" value="bot_report.terminal" checked/);
    assert.doesNotMatch(ordinaryHtml, /name="scopes" value="offline_access" checked/);

    // Real Chromium verifies the read-only browser probes when installed. The
    // HTTP/CSRF/OAuth fixture above still runs on PCs without a browser binary.
    const { chromium } = await import('@playwright/test');
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      console.log('T5 browser check skipped: Chromium is not installed on this PC');
    }
    if (browser) {
      try {
        const context = await browser.newContext({ extraHTTPHeaders: headers });
        const separator = authenticatedCookie.indexOf('=');
        await context.addCookies([
          {
            name: authenticatedCookie.slice(0, separator),
            value: authenticatedCookie.slice(separator + 1),
            url: base,
          },
        ]);
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(base + '/admin/onboarding');
        assert.equal(await page.locator('[data-onboarding-step]').count(), 6);
        await page.waitForFunction(() =>
          document
            .querySelector('[data-worker-installer-message]')
            ?.textContent?.includes('returned HTTP 503'),
        );
        assert.match(await page.locator('[data-worker-installer-message]').innerText(), /HTTP 503/);
        assert.equal(
          await page.locator('[data-onboarding-status]').getAttribute('data-onboarding-status'),
          'blocked',
        );
        assert.match(
          await page.locator('#quickstart-endpoint-check').innerText(),
          /OAuth discovery responded/,
        );
        // Desktop and narrow mobile views must keep the setup status readable.
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 844 });
          const dimensions = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          assert.ok(
            dimensions.scrollWidth <= dimensions.clientWidth,
            'No horizontal onboarding overflow at ' + width + 'px',
          );
          assert.equal(
            await page
              .locator('[data-chatgpt-verification]')
              .getAttribute('data-chatgpt-verification'),
            'unverified',
          );
        }
        // A forged 200 HEAD must not defeat the server-side release gate.
        await page.route('**/worker/install.sh', async (route) =>
          route.fulfill({ status: 200, body: '' }),
        );
        await page.reload();
        await page.waitForFunction(() =>
          document
            .querySelector('[data-worker-installer-message]')
            ?.textContent?.includes('HTTP response'),
        );
        assert.equal(
          await page.locator('[data-onboarding-status]').getAttribute('data-onboarding-status'),
          'blocked',
        );
        assert.equal(
          await page.locator('[data-onboarding-step="4"]').getAttribute('data-state'),
          'blocked',
        );
        await page.unroute('**/worker/install.sh');
        // Malformed discovery metadata must also block the endpoint, not imply READY.
        await page.route('**/.well-known/oauth-authorization-server', async (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              issuer: 'https://attacker.invalid',
              token_endpoint: 'https://attacker.invalid/oauth/token',
            }),
          }),
        );
        await page.reload();
        await page.waitForFunction(() =>
          document
            .querySelector('#quickstart-endpoint-check')
            ?.textContent?.includes('Blocked or unverified'),
        );
        assert.equal(
          await page.locator('[data-onboarding-step="3"]').getAttribute('data-state'),
          'blocked',
        );
        assert.equal(
          await page.locator('[data-onboarding-status]').getAttribute('data-onboarding-status'),
          'blocked',
        );
        await page.unroute('**/.well-known/oauth-authorization-server');
        assert.deepEqual(pageErrors, [], 'Wizard JavaScript must not throw');
        await context.close();
      } finally {
        await browser.close();
      }
    }

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
        Buffer.from([registered.client.client_id, registered.rawSecret].join(':')).toString(
          'base64',
        ),
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
    assert.equal(
      await (
        await import('../src/repositories/mcpOAuthRepository.js')
      ).default.hasAdminRuntimeCall(),
      false,
    );
    const unauthorized = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'runtime_info', arguments: {} },
      }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(
      await (
        await import('../src/repositories/mcpOAuthRepository.js')
      ).default.hasAdminRuntimeCall(),
      false,
    );
    const authenticatedCall = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        ...headers,
        authorization: `Bearer ${grantBody.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'runtime_info', arguments: {} },
      }),
    });
    assert.equal(authenticatedCall.status, 200);
    assert.match(await authenticatedCall.text(), /"result"|"content"/);
    const oauthRepo = (await import('../src/repositories/mcpOAuthRepository.js')).default;
    for (let attempt = 0; attempt < 20 && !(await oauthRepo.hasAdminRuntimeCall()); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      await oauthRepo.hasAdminRuntimeCall(),
      true,
      'Authenticated read-only MCP call must be audited',
    );
    const afterVerifiedCall = await fetch(base + '/admin/onboarding', {
      headers: { ...headers, cookie: authenticatedCookie },
    });
    const postCallGuide = await afterVerifiedCall.text();
    assert.match(postCallGuide, /data-onboarding-step="6" data-complete="true"/);
    assert.match(postCallGuide, /data-onboarding-status="blocked"/);
    assert.match(postCallGuide, /data-chatgpt-verification="unverified"/);
    assert.doesNotMatch(postCallGuide, /All six steps complete/);

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
    const version = db.prepare('SELECT version FROM railway_schema_versions').get() as {
      version: string;
    };
    assert.equal(version.version, '2026-11-12-initial');
    assert.equal(
      await (await import('../src/routes/railwaySetupRoutes.js')).default.isOwnerSetupComplete(),
      true,
    );
    const session = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number;
    };
    assert.ok(session.count > 0, 'Admin setup session must survive process restart');
    const ownerCount = db
      .prepare('SELECT COUNT(*) AS count FROM system_settings WHERE key = ?')
      .get('bootstrap.admin_password_hash') as { count: number };
    assert.equal(
      ownerCount.count,
      1,
      'Concurrent owner claims must leave exactly one bootstrap credential',
    );
    server = http.createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const restartedAddress = server.address();
    if (!restartedAddress || typeof restartedAddress === 'string') {
      throw new Error('Missing restarted server address');
    }
    const restartedBase = 'http://127.0.0.1:' + restartedAddress.port;
    const persistedAdmin = await fetch(restartedBase + '/admin', {
      headers: { ...headers, cookie: authenticatedCookie },
      redirect: 'manual',
    });
    assert.equal(persistedAdmin.status, 200, 'Authenticated session must survive restart');
    const adminCsrf = csrf(await persistedAdmin.text());
    assert.ok(adminCsrf);
    const logout = await fetch(restartedBase + '/logout', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...headers,
        cookie: authenticatedCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ _csrf: adminCsrf }).toString(),
    });
    assert.equal(logout.status, 302);
    assert.equal(
      (
        await fetch(restartedBase + '/admin', {
          headers: { ...headers, cookie: authenticatedCookie },
          redirect: 'manual',
        })
      ).status,
      302,
      'Logged-out session must not retain Admin access',
    );
    let rateLimited = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await fetch(restartedBase + '/setup', {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...headers,
          cookie: firstCookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          _csrf: token,
          setup_key: 'X'.repeat(43),
          password: 'PrivateRailwayAdmin2026!',
          confirm_password: 'PrivateRailwayAdmin2026!',
        }).toString(),
      });
      if (result.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert.equal(rateLimited, true, 'Repeated setup attempts must be rate-limited');
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

void test('Even fully evidenced local prerequisites never attest external ChatGPT READY', async () => {
  const before = process.env.MCP_PLATFORM;
  try {
    process.env.MCP_PLATFORM = 'local';
    const { onboardingPage } = await import('../src/http/pages.js');
    const common = {
      storage: { state: 'READY', operational: true },
      ready: true,
      workerReady: true,
      clientReady: true,
      firstCall: true,
      enabled: true,
      csrfToken: 'test-csrf-only',
    };
    const completeLocalFacts = onboardingPage({
      ...common,
      baseUrl: 'https://owner.example',
    });
    assert.match(completeLocalFacts, /data-onboarding-step="6" data-complete="true"/);
    assert.match(completeLocalFacts, /data-onboarding-status="pending"/);
    assert.match(completeLocalFacts, /data-chatgpt-verification="unverified"/);
    assert.match(completeLocalFacts, /ChatGPT connection still needs external verification/);
    assert.doesNotMatch(completeLocalFacts, /data-onboarding-status="done"/);
    const unsafeOrigin = onboardingPage({
      ...common,
      baseUrl: 'https://user:pass@owner.example',
    });
    assert.match(unsafeOrigin, /data-onboarding-status="blocked"/);
    assert.match(unsafeOrigin, /Invalid or unsafe configuration/);
    assert.match(unsafeOrigin, /disabled/);
    process.env.MCP_PLATFORM = 'railway';
    const blockedRailway = onboardingPage({
      ...common,
      baseUrl: 'https://owner.example',
    });
    assert.match(blockedRailway, /data-onboarding-status="blocked"/);
    assert.match(blockedRailway, /WORKER_SIGNED_RELEASE_PENDING/);
    assert.match(blockedRailway, /data-onboarding-step="4" data-complete="false"/);
    const insecureRailway = onboardingPage({
      ...common,
      baseUrl: 'http://127.0.0.1:3399',
    });
    assert.match(insecureRailway, /data-onboarding-step="3" data-complete="false"/);
    assert.match(insecureRailway, /data-onboarding-status="blocked"/);
  } finally {
    if (before === undefined) delete process.env.MCP_PLATFORM;
    else process.env.MCP_PLATFORM = before;
  }
});
