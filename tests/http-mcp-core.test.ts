import test from 'node:test';
import type OAuthServiceModule from '../src/services/mcpOAuthService';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import helper from './helper';
const { setupEnv, cleanup, initDb, issueToken, parseMcpResponse } = helper;

function runProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({ code: Number.isInteger(code) ? Number(code) : 1, stdout, stderr }),
    );
  });
}

const env = setupEnv('http');
initDb();
let server: http.Server;
let baseUrl = '';

test.before(async () => {
  const app = (await import('../src/app.js')).default;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanup(env.dir);
});

void test('HTTP surface is MCP-only', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as {
    ok: boolean;
    service: string;
    mode: string;
    database: string;
  };
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.service, 'mcp_worker');
  assert.equal(healthBody.mode, 'mcp-admin');
  assert.equal(healthBody.database, 'TEST_SQLITE');

  const login = await fetch(`${baseUrl}/login`);
  assert.equal(login.status, 200);
  const html = await login.text();
  assert.match(html, /mcp_worker/);
  assert.doesNotMatch(html, /Dashboard|Antigravity|Telegram|Bot Inbox/);

  for (const path of ['/antigravity', '/bots', '/reports', '/control-plane']) {
    const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 404);
  }
});

void test('signed Worker installer and distribution routes always reject unapproved artifacts', async () => {
  // A source-unapproved signed release must not be distributable on local or
  // unknown platforms either. Native script shape is verified by isolated
  // signer/installer fixture tests, not by publishing HTTP 200 templates.
  for (const endpoint of [
    '/worker/install.sh',
    '/worker/install-linux.sh',
    '/worker/install-macos.sh',
    '/worker/install.ps1',
    '/worker/install-windows.ps1',
    '/worker/dist/SHA256SUMS',
    '/worker/dist/SHA256SUMS.sig',
    '/worker/dist/WORKER_RELEASE',
    '/worker/dist/worker_mcp-linux-amd64',
    '/worker/dist/cli.js',
    '/worker/dist/lifecycle.js',
    '/worker/dist/not-allowed',
  ]) {
    const response = await fetch(`${baseUrl}${endpoint}`, { redirect: 'manual' });
    assert.equal(response.status, 503, endpoint);
    assert.equal(response.headers.get('cache-control'), 'no-store', endpoint);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'WORKER_SIGNED_RELEASE_PENDING', endpoint);
  }
});

void test('unapproved curl installer fails closed without installing a Worker binary', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker_mcp-pending-'));
  try {
    const binDir = path.join(home, '.local', 'bin');
    const installRoot = path.join(home, '.local', 'share', 'worker_mcp');
    const env = {
      ...process.env,
      HOME: home,
      MCP_WORKER_WORKER_HOME: path.join(home, '.worker_mcp'),
      MCP_WORKER_WORKER_INSTALL_ROOT: installRoot,
      MCP_WORKER_WORKER_BIN_DIR: binDir,
      MCP_WORKER_WORKER_SKIP_SERVICE: '1',
    };
    const result = await runProcess(
      'sh',
      [
        '-c',
        `curl -fsSL ${baseUrl}/worker/install.sh -o "$HOME/installer.sh" && sh "$HOME/installer.sh"`,
      ],
      { env },
    );
    assert.notEqual(result.code, 0, 'unapproved public install unexpectedly succeeded');
    assert.match(result.stderr, /(?:503|signed release not approved)/i);
    assert.equal(fs.existsSync(path.join(installRoot, 'current', 'worker_mcp')), false);
    assert.equal(fs.existsSync(path.join(binDir, 'worker_mcp')), false);
    assert.equal(fs.existsSync(path.join(env.MCP_WORKER_WORKER_HOME, 'state.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

void test('OAuth discovery and unauthenticated MCP challenge remain available', async () => {
  const metadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(metadata.status, 200);
  const body: unknown = await metadata.json();
  assert.ok(body && typeof body === 'object');
  assert.ok('authorization_endpoint' in body && typeof body.authorization_endpoint === 'string');
  assert.ok('token_endpoint' in body && typeof body.token_endpoint === 'string');
  assert.equal(body.authorization_endpoint.endsWith('/oauth/authorize'), true);
  assert.equal(body.token_endpoint.endsWith('/oauth/token'), true);

  const denied = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate') || '', /oauth-protected-resource/);
});

void test('administrator login can authorize an OAuth client through the minimal consent page', async () => {
  const login = await fetch(`${baseUrl}/login`);
  const loginHtml = await login.text();
  const firstCookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const csrf = loginHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(firstCookie);
  assert.ok(csrf);

  const form = new URLSearchParams({
    _csrf: csrf,
    username: 'admin',
    password: 'TestAdminPassword2026!',
    returnTo: '/',
  });
  const signedIn = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: firstCookie },
    body: form.toString(),
  });
  assert.equal(signedIn.status, 302);
  const authenticatedCookie = (signedIn.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(authenticatedCookie);

  const service = (await import('../src/services/mcpOAuthService.js')).default;
  const config = (await import('../src/config/mcpConfig.js')).default;
  const registered = await service.registerClient({
    displayName: 'Consent Test Client',
    principalId: 'principal:consent_test',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    allowedScopes: ['mcp_worker.read', 'mcp_worker.terminal'],
  });
  assert.ok(registered.client);
  const verifier = 'consent-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    client_id: registered.client.client_id,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    response_type: 'code',
    scope: 'mcp_worker.read mcp_worker.terminal',
    state: 'consent-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: config.resourceUrl,
  });
  const consent = await fetch(`${baseUrl}/oauth/authorize?${query}`, {
    redirect: 'manual',
    headers: { cookie: authenticatedCookie },
  });
  assert.equal(consent.status, 200);
  const consentHtml = await consent.text();
  assert.match(consentHtml, /Authorize MCP Access/);
  assert.match(consentHtml, /Consent Test Client/);
  assert.match(consentHtml, /mcp_worker\.terminal/);
  const consentCsrf = consentHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(consentCsrf);

  const allowForm = new URLSearchParams({
    _csrf: consentCsrf,
    client_id: registered.client.client_id,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scope: 'mcp_worker.read mcp_worker.terminal',
    state: 'consent-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: config.resourceUrl,
    action: 'allow',
  });
  const allowed = await fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authenticatedCookie },
    body: allowForm.toString(),
  });
  assert.equal(allowed.status, 302);
  const location = allowed.headers.get('location');
  assert.ok(location);
  const redirect = new URL(location);
  const code = redirect.searchParams.get('code');
  assert.ok(code);
  assert.equal(redirect.searchParams.get('state'), 'consent-state');

  const tokenForm = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    resource: config.resourceUrl,
    code_verifier: verifier,
  });
  const token = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${registered.client.client_id}:${registered.rawSecret}`).toString('base64')}`,
    },
    body: tokenForm.toString(),
  });
  assert.equal(token.status, 200);
  const tokenBody: unknown = await token.json();
  assert.ok(tokenBody && typeof tokenBody === 'object');
  assert.ok('access_token' in tokenBody && typeof tokenBody.access_token === 'string');
  assert.ok('scope' in tokenBody && typeof tokenBody.scope === 'string');
  assert.match(tokenBody.access_token, /^br_at_/);
  assert.equal(tokenBody.scope, 'mcp_worker.read mcp_worker.terminal');
});

void test('OAuth rejects malformed scope without consuming a valid refresh token', async () => {
  const { default: config } = await import('../src/config/mcpConfig.js');
  const fixture = (await issueToken({ scopes: ['mcp_worker.read', 'offline_access'] })) as Awaited<
    ReturnType<typeof OAuthServiceModule.registerClient>
  > & { token: Awaited<ReturnType<typeof OAuthServiceModule.exchangeAuthorizationCode>> };
  assert.ok(fixture.client);
  assert.ok(fixture.token.refresh_token);
  // Verify malformed input at the HTTP boundary rather than weakening scope checks.
  const headers = {
    'content-type': 'application/json',
    authorization:
      'Basic ' + Buffer.from(fixture.client.client_id + ':' + fixture.rawSecret).toString('base64'),
  };
  const body = {
    grant_type: 'refresh_token',
    refresh_token: fixture.token.refresh_token,
    resource: config.resourceUrl,
  };
  const malformed = await fetch(baseUrl + '/oauth/token', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, scope: ['mcp_worker.read'] }),
  });
  assert.equal(malformed.status, 400);
  const error: unknown = await malformed.json();
  assert.ok(error && typeof error === 'object' && 'error' in error);
  assert.equal(error.error, 'invalid_request');
  const valid = await fetch(baseUrl + '/oauth/token', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, scope: 'mcp_worker.read' }),
  });
  assert.equal(valid.status, 200);
  const result: unknown = await valid.json();
  assert.ok(result && typeof result === 'object' && 'scope' in result);
  assert.equal(result.scope, 'mcp_worker.read');
});

void test('authenticated MCP initialize returns instructions and exactly 15 tools', async () => {
  const issued = await issueToken();
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${issued.token.access_token}`,
  };
  const init = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  assert.equal(init.status, 200);
  const initBody = await parseMcpResponse(init);
  assert.match(
    (initBody.result as { instructions?: string } | undefined)?.instructions || '',
    /MCP-only/,
  );

  const list = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert.equal(list.status, 200);
  const listBody = await parseMcpResponse(list);
  const names = (listBody.result?.tools || []).map((tool) => tool.name);
  assert.equal(names.length, 15);
  assert.ok(names.includes('runtime_info'));
  assert.ok(names.includes('file_patch'));
  assert.ok(names.includes('process_logs'));
  assert.ok(!names.some((name) => /notification|inbox|control|antigravity/i.test(name)));

  await new Promise((resolve) => setImmediate(resolve));
  const oauthRepo = (await import('../src/repositories/mcpOAuthRepository.js')).default;
  const auditRows = await oauthRepo.listAuditLogs({
    clientId: issued.client.client_id,
    limit: 10,
  });
  const initializeAudit = auditRows.find(
    (row) => row.mcp_method === 'initialize' && row.result === 'SUCCESS',
  );
  const toolsListAudit = auditRows.find(
    (row) => row.mcp_method === 'tools/list' && row.result === 'SUCCESS',
  );
  assert.ok(initializeAudit);
  assert.ok(typeof initializeAudit.id === 'string');
  assert.ok(toolsListAudit);
  assert.ok(auditRows.every((row) => row.client_id === issued.client.client_id));

  const initializeDetail = await oauthRepo.findAuditLogById(initializeAudit.id);
  assert.ok(initializeDetail);
  assert.ok(typeof initializeDetail.request_payload === 'string');
  assert.ok(typeof initializeDetail.response_payload === 'string');
  assert.match(initializeDetail.request_payload, /"method":"initialize"/);
  assert.match(initializeDetail.response_payload, /"jsonrpc":"2\.0"/);
  assert.match(initializeDetail.response_payload, /MCP-only/);
  assert.equal(Number(initializeDetail.request_truncated), 0);
  assert.equal(Number(initializeDetail.response_truncated), 0);
});
