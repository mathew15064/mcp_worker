import test from 'node:test';
import assert from 'node:assert/strict';
import oauthResourceServer = require('../src/auth/oauthResourceServer');
import {AuthenticatedPrincipal} from '../src/auth/principal';
import oauthService = require('../src/services/mcpOAuthService');
const {setupEnv, cleanup, initDb, issueToken} = require('./helper') as {setupEnv(name: string): {dir: string}; cleanup(dir: string): void; initDb(): void; issueToken(): Promise<{token: {access_token: string; refresh_token: string}}>};

const env = setupEnv('oauth');
test.after(() => cleanup(env.dir));
initDb();

test('local OAuth issues terminal-scoped token without control-plane bindings', async () => {
  const issued = await issueToken();
  assert.match(issued.token.access_token, /^br_at_/);
  assert.match(issued.token.refresh_token, /^br_rt_/);
  const principal = await oauthResourceServer.verifyToken(issued.token.access_token);
  assert.equal(principal.principal_id, 'principal:gpt_client');
  assert.equal(principal.actor_id, 'principal:gpt_client');
  assert.equal(principal.hasScope('bot_report.read'), true);
  assert.equal(principal.hasScope('bot_report.terminal'), true);
});

test('terminal scope is enforced independently of read scope', () => {
  const principal = new AuthenticatedPrincipal({ principalId: 'principal:read_only', scopes: ['bot_report.read'] });
  assert.throws(() => principal.assertScope('bot_report.terminal'), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INSUFFICIENT_SCOPE');
});

test('admin OAuth client principal is generated from its immutable client id when omitted', async () => {
  const registered = await oauthService.registerClient({
    displayName: 'Auto Principal Client',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    allowedScopes: ['bot_report.read']
  });
  assert.ok(registered.client);
  assert.equal(registered.client.principal_id, `principal:client:${registered.client.client_id}`);
});
