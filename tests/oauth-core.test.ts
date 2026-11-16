import test from 'node:test';
import assert from 'node:assert/strict';
import oauthResourceServer from '../src/auth/oauthResourceServer';
import { AuthenticatedPrincipal } from '../src/auth/principal';
import oauthService from '../src/services/mcpOAuthService';
import type { OAuthConfig } from '../src/services/contracts/oauthContracts';
import helper from './helper';
const { setupEnv, cleanup, initDb, issueToken } = helper;

const env = setupEnv('oauth');
test.after(() => cleanup(env.dir));
initDb();

void test('local OAuth issues terminal-scoped token without control-plane bindings', async () => {
  const issued = await issueToken();
  assert.match(issued.token.access_token, /^br_at_/);
  assert.ok(issued.token.refresh_token, 'Fixture must issue an offline refresh token');
  assert.match(issued.token.refresh_token, /^br_rt_/);
  const principal = await oauthResourceServer.verifyToken(issued.token.access_token);
  assert.equal(principal.principal_id, 'principal:gpt_client');
  assert.equal(principal.actor_id, 'principal:gpt_client');
  assert.equal(principal.hasScope('mcp_worker.read'), true);
  assert.equal(principal.hasScope('mcp_worker.terminal'), true);
});

void test('terminal scope is enforced independently of read scope', () => {
  const principal = new AuthenticatedPrincipal({
    principalId: 'principal:read_only',
    scopes: ['mcp_worker.read'],
  });
  assert.throws(
    () => principal.assertScope('mcp_worker.terminal'),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'INSUFFICIENT_SCOPE',
  );
});

void test('admin OAuth client principal is generated from its immutable client id when omitted', async () => {
  const registered = await oauthService.registerClient({
    displayName: 'Auto Principal Client',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    allowedScopes: ['mcp_worker.read'],
  });
  assert.ok(registered.client);
  assert.equal(registered.client.principal_id, `principal:client:${registered.client.client_id}`);
});

void test('OAuth revocation only calls client-scoped storage operations for any token hint', async () => {
  const calls: string[] = [];
  const clientId = 'client-revoking';
  const secret = 'test-only-secret';
  const repo = {
    findClientByClientId: (id: string) =>
      Promise.resolve(
        id === clientId
          ? {
              client_id: clientId,
              status: 'active',
              owner_user_id: null,
              client_secret_hash: oauthService.hash(secret),
            }
          : null,
      ),
    revokeAccessTokenForClient: (hash: string, id: string) => {
      calls.push(`access:${hash}:${id}`);
      return Promise.resolve();
    },
    revokeRefreshTokenForClient: (hash: string, id: string) => {
      calls.push(`refresh:${hash}:${id}`);
      return Promise.resolve();
    },
    revokeAccessToken: () =>
      Promise.reject(new Error('Unscoped access-token revoke must not be called')),
    revokeRefreshToken: () =>
      Promise.reject(new Error('Unscoped refresh-token revoke must not be called')),
  };
  const service = new oauthService.McpOAuthService(repo as unknown as typeof oauthService.repo);
  const token = 'known-test-token';
  const hash = service.hash(token);
  await service.revokeToken({
    clientId,
    clientSecret: secret,
    token,
    tokenTypeHint: 'access_token',
  });
  assert.deepEqual(calls.splice(0), [`access:${hash}:${clientId}`]);
  await service.revokeToken({
    clientId,
    clientSecret: secret,
    token,
    tokenTypeHint: 'refresh_token',
  });
  assert.deepEqual(calls.splice(0), [`refresh:${hash}:${clientId}`]);
  for (const hint of [undefined, 'unexpected']) {
    await service.revokeToken({ clientId, clientSecret: secret, token, tokenTypeHint: hint });
    assert.deepEqual(calls.splice(0), [
      `access:${hash}:${clientId}`,
      `refresh:${hash}:${clientId}`,
    ]);
  }
  const noStoragePort = new oauthService.McpOAuthService({
    ...repo,
    revokeAccessTokenForClient: undefined,
  } as unknown as typeof oauthService.repo);
  await assert.rejects(
    noStoragePort.revokeToken({ clientId, clientSecret: secret, token }),
    { error: 'server_error' },
    'Missing T4 storage interface must fail closed',
  );
});

void test('OAuth registration rejects unsafe redirect URI schemes and URI fragments', async () => {
  const invalid = [
    'javascript://localhost/callback',
    'file:///tmp/callback',
    'http://client.example.invalid/callback',
    'http://alice@localhost/callback',
    'https://alice:secret@client.example.invalid/callback',
    'https://client.example.invalid/callback#fragment',
    'http://localhost/callback#fragment',
    'https://client.example.invalid/callback#',
    'https://@client.example.invalid/callback',
    'https://client.example.invalid@attacker.invalid/callback',
    'http://[::1]/callback#',
  ];
  for (const uri of invalid) {
    await assert.rejects(
      oauthService.registerClient({
        displayName: 'Unsafe Redirect Negative',
        redirectUris: [uri],
        allowedScopes: ['mcp_worker.read'],
      }),
      { error: 'invalid_client_metadata' },
      uri,
    );
  }
  for (const uri of [
    'https://client.example.invalid/callback',
    'http://localhost:7444/callback',
    'http://127.0.0.1:7444/callback',
    'http://[::1]:7444/callback',
  ]) {
    const registered = await oauthService.registerClient({
      displayName: 'Safe Redirect Positive',
      redirectUris: [uri],
      allowedScopes: ['mcp_worker.read'],
    });
    assert.ok(registered.client);
    assert.deepEqual(registered.client.redirect_uris, [uri]);
  }
});

void test('authorization blocks legacy unsafe callbacks and malformed PKCE S256', async () => {
  const safeRedirect = 'https://client.example.invalid/callback';
  const clientId = 'legacy-client';
  let storedRedirect = safeRedirect;
  const repo = {
    findClientByClientId: () =>
      Promise.resolve({
        client_id: clientId,
        status: 'active',
        owner_user_id: null,
        redirect_uris: [storedRedirect],
        allowed_scopes: ['mcp_worker.read'],
      }),
  };
  const service = new oauthService.McpOAuthService(repo as unknown as typeof oauthService.repo);
  const request = {
    clientId,
    redirectUri: safeRedirect,
    responseType: 'code',
    scope: 'mcp_worker.read',
    state: 'csrf-state',
    codeChallenge: 'a'.repeat(43),
    codeChallengeMethod: 'S256',
    resource: service.config.resourceUrl,
  };
  const valid = await service.validateAuthorizeRequest(request);
  assert.deepEqual(valid.scopes, ['mcp_worker.read']);
  for (const redirectUri of [
    'https://attacker.invalid/#',
    'https://@client.example.invalid/callback',
    'javascript://client.example.invalid/callback',
  ]) {
    storedRedirect = redirectUri;
    await assert.rejects(service.validateAuthorizeRequest({ ...request, redirectUri }), {
      error: 'invalid_request',
    });
  }
  storedRedirect = safeRedirect;
  for (const codeChallenge of ['short', 'a'.repeat(42), 'a'.repeat(42) + '=', '!'.repeat(43)]) {
    await assert.rejects(service.validateAuthorizeRequest({ ...request, codeChallenge }), {
      error: 'invalid_request',
    });
  }
  await assert.rejects(
    service.validateAuthorizeRequest({ ...request, codeChallengeMethod: 'plain' }),
    {
      error: 'invalid_request',
    },
  );
  await assert.rejects(
    service.validateAuthorizeRequest({ ...request, resource: 'https://other.invalid/mcp' }),
    {
      error: 'invalid_target',
    },
  );
});

void test('OAuth config can be injected as a narrow policy without widening scopes', async () => {
  const policy: OAuthConfig = {
    supportedScopes: ['mcp_worker.read'],
    resourceUrl: 'http://127.0.0.1:3333/mcp',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2592000,
    authCodeTtlSeconds: 300,
  };
  const service = new oauthService.McpOAuthService(oauthService.repo, policy);
  const created = await service.registerClient({
    displayName: 'Policy constrained client',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    allowedScopes: ['mcp_worker.read', 'mcp_worker.terminal', 'offline_access'],
  });
  assert.ok(created.client);
  assert.deepEqual(created.client.allowed_scopes, ['mcp_worker.read']);
});

void test('new OAuth clients and requests default to read-only', async () => {
  const redirectUri = 'https://client.example.invalid/callback';
  const readOnly = await oauthService.registerClient({
    displayName: 'Default read-only client',
    redirectUris: [redirectUri],
  });
  assert.ok(readOnly.client);
  assert.deepEqual(readOnly.client.allowed_scopes, ['mcp_worker.read']);

  const elevated = await oauthService.registerClient({
    displayName: 'Explicitly elevated client',
    redirectUris: [redirectUri],
    allowedScopes: ['mcp_worker.read', 'mcp_worker.terminal', 'offline_access'],
  });
  assert.ok(elevated.client);
  const request = await oauthService.validateAuthorizeRequest({
    clientId: elevated.client.client_id,
    redirectUri,
    responseType: 'code',
    scope: '',
    codeChallenge: 'a'.repeat(43),
    codeChallengeMethod: 'S256',
    resource: oauthService.config.resourceUrl,
  });
  assert.deepEqual(request.scopes, ['mcp_worker.read']);
});
