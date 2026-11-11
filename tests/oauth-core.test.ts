import test from 'node:test';
import assert from 'node:assert/strict';
import oauthResourceServer from '../src/auth/oauthResourceServer';
import { AuthenticatedPrincipal } from '../src/auth/principal';
import oauthService from '../src/services/mcpOAuthService';
import type { OAuthConfig } from '../src/services/contracts/oauthContracts';
const { setupEnv, cleanup, initDb, issueToken } = require('./helper') as {
  setupEnv(name: string): { dir: string };
  cleanup(dir: string): void;
  initDb(): void;
  issueToken(): Promise<{ token: { access_token: string; refresh_token: string } }>;
};

const env = setupEnv('oauth');
test.after(() => cleanup(env.dir));
initDb();

void test('local OAuth issues terminal-scoped token without control-plane bindings', async () => {
  const issued = await issueToken();
  assert.match(issued.token.access_token, /^br_at_/);
  assert.match(issued.token.refresh_token, /^br_rt_/);
  const principal = await oauthResourceServer.verifyToken(issued.token.access_token);
  assert.equal(principal.principal_id, 'principal:gpt_client');
  assert.equal(principal.actor_id, 'principal:gpt_client');
  assert.equal(principal.hasScope('bot_report.read'), true);
  assert.equal(principal.hasScope('bot_report.terminal'), true);
});

void test('terminal scope is enforced independently of read scope', () => {
  const principal = new AuthenticatedPrincipal({
    principalId: 'principal:read_only',
    scopes: ['bot_report.read'],
  });
  assert.throws(
    () => principal.assertScope('bot_report.terminal'),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'INSUFFICIENT_SCOPE',
  );
});

void test('admin OAuth client principal is generated from its immutable client id when omitted', async () => {
  const registered = await oauthService.registerClient({
    displayName: 'Auto Principal Client',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    allowedScopes: ['bot_report.read'],
  });
  assert.ok(registered.client);
  assert.equal(registered.client.principal_id, `principal:client:${registered.client.client_id}`);
});

void test('OAuth config can be injected as a narrow policy without widening scopes', async () => {
  const policy: OAuthConfig = {
    supportedScopes: ['bot_report.read'],
    resourceUrl: 'http://127.0.0.1:3333/mcp',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2592000,
    authCodeTtlSeconds: 300,
  };
  const service = new oauthService.McpOAuthService(oauthService.repo, policy);
  const created = await service.registerClient({
    displayName: 'Policy constrained client',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    allowedScopes: ['bot_report.read', 'bot_report.terminal', 'offline_access'],
  });
  assert.ok(created.client);
  assert.deepEqual(created.client.allowed_scopes, ['bot_report.read']);
});
