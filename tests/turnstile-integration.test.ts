import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import helper from './helper';

const env = helper.setupEnv('turnstile-http');
helper.initDb();
const originalFetch = globalThis.fetch;
const key = '1x00000000000000000000AA';
const secret = '1x0000000000000000000000000000000AA';
let nextSiteverify: {
  success: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
} = {
  success: true,
  hostname: 'localhost',
  action: 'login',
};
let verificationCalls = 0;
let simulateOutage = false;
let server: http.Server;
let origin = '';
let adminCookie = '';
let adminCsrf = '';

function csrf(html: string) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
}
function sessionCookie(response: Response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header);
  return header.split(';')[0];
}
async function request(path: string, options: RequestInit = {}) {
  return fetch(origin + path, { redirect: 'manual', ...options });
}
async function formPost(path: string, cookie: string, values: Record<string, string>) {
  return request(path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
  });
}

test.before(async () => {
  globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (
      typeof input === 'string' &&
      input.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    ) {
      verificationCalls += 1;
      if (simulateOutage) return Promise.reject(new Error('simulated Cloudflare outage'));
      const body = init?.body;
      assert.ok(body instanceof URLSearchParams);
      assert.equal(body.get('secret'), secret);
      return Promise.resolve(new Response(JSON.stringify(nextSiteverify), { status: 200 }));
    }
    return originalFetch(input, init);
  };
  const app = (await import('../src/app.js')).default;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const loginPage = await request('/login');
  const loginCookie = sessionCookie(loginPage);
  const loginCsrf = csrf(await loginPage.text());
  const signedIn = await formPost('/login', loginCookie, {
    _csrf: loginCsrf,
    username: 'admin',
    password: 'TestAdminPassword2026!',
  });
  assert.equal(signedIn.status, 302);
  adminCookie = sessionCookie(signedIn);
  const page = await request('/admin/settings/turnstile', { headers: { cookie: adminCookie } });
  assert.equal(page.status, 200);
  adminCsrf = csrf(await page.text());
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  helper.cleanup(env.dir);
});

void test('Admin-only settings encrypts key; public state only reveals site key', async () => {
  const guest = await request('/admin/settings/turnstile');
  assert.equal(guest.status, 302);
  const rejected = await formPost('/admin/settings/turnstile', adminCookie, {
    _csrf: adminCsrf,
    site_key: key,
    secret_key: secret,
    enabled: 'true',
  });
  assert.equal(rejected.status, 303);
  const settings = (await import('../src/services/runtimeSettingsService.js')).default;
  assert.equal(settings.bool('turnstile.enabled'), false);
  nextSiteverify = { success: true, hostname: 'localhost', action: 'config-test' };
  const tested = await formPost('/admin/settings/turnstile/test', adminCookie, {
    _csrf: adminCsrf,
    site_key: key,
    secret_key: secret,
    'cf-turnstile-response': 'verified-before-enable',
  });
  assert.equal(tested.status, 303);
  const save = await formPost('/admin/settings/turnstile', adminCookie, {
    _csrf: adminCsrf,
    site_key: key,
    secret_key: secret,
    enabled: 'true',
  });
  assert.equal(save.status, 303);
  const stored = settings.get('turnstile.secret_key');
  assert.match(stored, /^enc:v1:/);
  assert.doesNotMatch(stored, new RegExp(secret));
  const response = await request('/api/ui/state?view=/login');
  const state = (await response.json()) as {
    turnstile: { enabled: boolean; siteKey: string };
    data?: { turnstile?: unknown };
  };
  assert.equal(state.turnstile.enabled, true);
  assert.equal(state.turnstile.siteKey, key);
  assert.equal(state.data?.turnstile, undefined);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(secret));
  const guestSettings = await request('/api/ui/state?view=/admin/settings/turnstile');
  assert.equal(guestSettings.status, 401);
});

void test('Login rejects missing/duplicate/wrong-action tokens and accepts valid tokens', async () => {
  const loginPage = await request('/login');
  const cookie = sessionCookie(loginPage);
  const html = await loginPage.text();
  assert.match(html, /cf-turnstile/);
  const fields = { _csrf: csrf(html), username: 'admin', password: 'TestAdminPassword2026!' };
  const missing = await formPost('/login', cookie, fields);
  assert.equal(missing.status, 403);
  assert.equal(verificationCalls, 1);
  nextSiteverify = {
    success: false,
    hostname: 'localhost',
    'error-codes': ['timeout-or-duplicate'],
  };
  const reused = await formPost('/login', cookie, {
    ...fields,
    'cf-turnstile-response': 'duplicate-token',
  });
  assert.equal(reused.status, 403);
  nextSiteverify = { success: true, hostname: 'other.example', action: 'register' };
  const wrongAction = await formPost('/login', cookie, {
    ...fields,
    'cf-turnstile-response': 'wrong-action',
  });
  assert.equal(wrongAction.status, 403);
  nextSiteverify = { success: true, hostname: 'localhost', action: 'login' };
  const valid = await formPost('/login', cookie, {
    ...fields,
    'cf-turnstile-response': 'valid-token',
  });
  assert.equal(valid.status, 302);
});

void test('Registration fails closed on missing Siteverify token and permits valid token', async () => {
  const page = await request('/register');
  const cookie = sessionCookie(page);
  const html = await page.text();
  assert.match(html, /cf-turnstile/);
  const base = {
    _csrf: csrf(html),
    username: 'turnstileuser',
    email: 'turnstile@example.com',
    display_name: 'CAPTCHA User',
    password: 'SafeTestPassword2026!',
  };
  const missing = await formPost('/register', cookie, base);
  assert.equal(missing.status, 400);
  nextSiteverify = { success: false, 'error-codes': ['timeout-or-duplicate'] };
  const expired = await formPost('/register', cookie, {
    ...base,
    'cf-turnstile-response': 'expired',
  });
  assert.equal(expired.status, 400);
  nextSiteverify = { success: true, hostname: 'localhost', action: 'register' };
  const valid = await formPost('/register', cookie, {
    ...base,
    'cf-turnstile-response': 'valid-register',
  });
  assert.equal(valid.status, 303);
});

void test('Siteverify outage fails closed and hostname mismatches are rejected', async () => {
  const service = await import('../src/services/turnstileService.js');
  nextSiteverify = { success: true, hostname: 'attacker.example', action: 'config-test' };
  const wrongHost = await service.validateToken('hostname-mismatch', 'config-test', {
    siteKey: '0x4AAAAAAAGMGMIWEkp0_KKKS',
    secret,
  });
  assert.equal(wrongHost, false);
  simulateOutage = true;
  const fail = await service.validateToken('unavailable', 'register');
  assert.equal(fail, false);
  simulateOutage = false;
});

void test('Admin Test configuration reports real Siteverify result; blank secret retains old key', async () => {
  nextSiteverify = { success: true, hostname: 'localhost', action: 'config-test' };
  const tested = await formPost('/admin/settings/turnstile/test', adminCookie, {
    _csrf: adminCsrf,
    site_key: key,
    secret_key: '',
    'cf-turnstile-response': 'test-token',
  });
  assert.equal(tested.status, 303);
  const page = await request('/api/ui/state?view=/admin/settings/turnstile', {
    headers: { cookie: adminCookie },
  });
  const data = (await page.json()) as {
    data: { turnstile: { passed: number; failed: number; hasSecret: boolean; lastResult: string } };
  };
  assert.ok(data.data.turnstile.passed >= 3);
  assert.ok(data.data.turnstile.failed >= 4);
  assert.equal(data.data.turnstile.hasSecret, true);
  assert.equal(data.data.turnstile.lastResult, 'passed');
  const settings = (await import('../src/services/runtimeSettingsService.js')).default;
  const oldValue = settings.get('turnstile.secret_key');
  const save = await formPost('/admin/settings/turnstile', adminCookie, {
    _csrf: adminCsrf,
    site_key: key,
    secret_key: '',
    enabled: 'false',
  });
  assert.equal(save.status, 303);
  assert.equal(settings.get('turnstile.secret_key'), oldValue);
  const after = await request('/api/ui/state?view=/login');
  const state = (await after.json()) as { turnstile: { enabled: boolean } };
  assert.equal(state.turnstile.enabled, false);
});
