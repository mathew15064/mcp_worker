// Run via stdin inside a disposable standalone app container:
// docker compose ... exec -T -e BOT_REPORT_STANDALONE_SMOKE=1 bot-report node - seed < tests/standalone-install-smoke.js
// Repeat with "verify" after setup/restart. Never run on a real installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const manager = require('./src/db/databaseManager');
const settings = require('./src/services/runtimeSettingsService');
const oauth = require('./src/services/mcpOAuthService');
const config = require('./src/config/mcpConfig');
const users = require('./src/services/userService');
const userRepo = require('./src/repositories/userRepository');
const workerRepo = require('./src/repositories/workerRepository');
const workerAuth = require('./src/services/workerAuthService');
const store = require('./src/db/bootstrapConfigStore');
const file = '/app/data/.standalone-smoke.json';
const base = 'http://127.0.0.1';
async function request(token, method, params) {
  const res = await fetch(base + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!token) { assert.equal(res.status, 401); return; }
  assert.equal(res.status, 200);
  const text = await res.text();
  const payload = text.split('\n').find(x => x.startsWith('data: '))?.slice(6) || text;
  const response = JSON.parse(payload);
  assert.ok(!response.error && !response.result?.isError);
  return response.result;
}
async function main() {
  assert.equal(process.env.BOT_REPORT_STANDALONE_SMOKE, '1');
  assert.ok(process.env.BUNDLED_MYSQL_PASSWORD);
  assert.match(process.env.MCP_PUBLIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  const mode = process.argv[2];
  assert.ok(['seed', 'verify'].includes(mode));
  assert.equal((await fetch(base + '/readyz')).status, 200);
  await manager.initialize(); await settings.load(manager.getAdapter());
  assert.equal(manager.status().state, 'READY');
  assert.equal(store.readPublic().host, 'mysql');
  assert.equal(manager.status().source.ran, 13);
  assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
  // Authenticate against the actual running local HTTP app, not a test-mode server.
  const page = await fetch(base + '/login');
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, username: 'admin', password: process.env.ADMIN_PASSWORD, returnTo: '/admin' })
  });
  assert.equal(login.status, 302);
  const session = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/admin', { headers: { cookie: session }, redirect: 'manual' })).status, 200);
  let fixture;
  if (mode === 'seed') {
    assert.equal(fs.existsSync(file), false);
    const tag = crypto.randomBytes(5).toString('hex');
    const user = await users.createUser({ username: 'smoke_' + tag, password: crypto.randomBytes(24).toString('hex') });
    const e = await workerRepo.createEnrollmentToken({ ttlSeconds: 600 });
    const keys = crypto.generateKeyPairSync('ed25519');
    const worker = await workerAuth.enroll({ token: e.token, name: 'Smoke-' + tag,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), capabilities: ['workspace.exec'] });
    const scopes = ['bot_report.read', 'bot_report.terminal'];
    const redirect = 'http://127.0.0.1/callback';
    const c = await oauth.registerClient({ displayName: 'Standalone smoke ' + tag, redirectUris: [redirect], allowedScopes: scopes });
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code = await oauth.issueAuthorizationCode({ clientId: c.client.client_id, userId: 'env-admin',
      principalId: c.client.principal_id, redirectUri: redirect, resource: config.resourceUrl, scopes,
      codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' });
    const token = await oauth.exchangeAuthorizationCode({ clientId: c.client.client_id, clientSecret: c.rawSecret,
      code, redirectUri: redirect, resource: config.resourceUrl, codeVerifier: verifier });
    await settings.set('standalone.smoke.marker', tag);
    fixture = { token: token.access_token, userId: user.id, workerId: worker.id, tag };
    // Temporary test-only access token, never an enrollment token; deleted after verification.
    fs.writeFileSync(file, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
  } else {
    fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  assert.ok(await userRepo.findById(fixture.userId));
  assert.ok(await workerRepo.findWorkerById(fixture.workerId));
  assert.equal(settings.get('standalone.smoke.marker'), fixture.tag);
  await request(null, 'tools/list', {});
  const catalog = await request(fixture.token, 'tools/list', {});
  assert.equal(catalog.tools.length, 19);
  const runtime = await request(fixture.token, 'tools/call', { name: 'runtime_info', arguments: {} });
  assert.equal(runtime.structuredContent.tool_count, 19);
  assert.equal(runtime.structuredContent.tool_schema_hash, '77fec371229586b76437ab2dd0b8bff3101c89d13baa5a223795a8a68d11fdb6');
  await request(fixture.token, 'tools/call', { name: 'terminal_list', arguments: {} });
  if (mode === 'verify') fs.unlinkSync(file);
  console.log('PASS ' + mode + ': actual local admin login, MySQL 13 migrations, user/Worker identity, OAuth token, 19 tools, runtime_info, terminal_list, unauthenticated rejection');
}
main().catch(e => { console.error('Smoke failed:', e.message); process.exitCode = 1; }).finally(() => manager.close());
