import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { MigrationRunner } from '../src/db/migrationRunner';
import oauthRepository from '../src/repositories/mcpOAuthRepository';
import oauthService from '../src/services/mcpOAuthService';
import mcpConfig from '../src/config/mcpConfig';

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

void test('libSQL OAuth repository preserves PKCE, refresh rotation, replay protection, revocation', async () => {
  const { createClient } = await import('@libsql/client');
  const db = new LibsqlAdapter(createClient({ url: ':memory:' }), { ownsClient: true });
  const repository = new oauthRepository.McpOAuthRepository(db);
  const service = new oauthService.McpOAuthService(repository, mcpConfig);
  try {
    await db.exec('PRAGMA foreign_keys=ON');
    await new MigrationRunner(db).migrate();
    const redirectUri = 'https://client.example.invalid/callback';
    const client = await service.registerClient({
      displayName: 'Typed OAuth Regression',
      redirectUris: [redirectUri],
      allowedScopes: ['bot_report.read', 'offline_access'],
    });
    assert.ok(client.client);
    const clientId = client.client.client_id;
    const verifier = 'typed-oauth-code-verifier-with-sufficient-entropy-0123456789';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const resource = mcpConfig.resourceUrl;
    const authorized = await service.validateAuthorizeRequest({
      clientId,
      redirectUri,
      responseType: 'code',
      scope: 'bot_report.read offline_access',
      state: 'regression',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      resource,
    });
    assert.deepEqual(authorized.scopes, ['bot_report.read', 'offline_access']);
    await assert.rejects(
      service.validateAuthorizeRequest({
        clientId,
        redirectUri,
        responseType: 'code',
        codeChallenge: challenge,
        codeChallengeMethod: 'plain',
        resource,
      }),
      { error: 'invalid_request' },
    );
    const code = await service.issueAuthorizationCode({
      clientId,
      userId: 'env-admin',
      principalId: client.client.principal_id,
      redirectUri,
      resource,
      scopes: authorized.scopes,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
    const args = {
      clientId,
      clientSecret: client.rawSecret,
      code,
      redirectUri,
      resource,
      codeVerifier: verifier,
    };
    const token = await service.exchangeAuthorizationCode(args);
    assert.equal(token.token_type, 'Bearer');
    assert.ok(token.refresh_token);
    await assert.rejects(service.exchangeAuthorizationCode(args), { error: 'invalid_grant' });
    const rotated = await service.exchangeRefreshToken({
      clientId,
      clientSecret: client.rawSecret,
      refreshToken: token.refresh_token,
      resource,
    });
    assert.ok(rotated.refresh_token);
    await assert.rejects(
      service.exchangeRefreshToken({
        clientId,
        clientSecret: client.rawSecret,
        refreshToken: token.refresh_token,
        resource,
      }),
      { error: 'invalid_grant' },
    );
    const compromised = await repository.findRefreshTokenByHash(sha(rotated.refresh_token));
    assert.ok(compromised?.revoked_at, 'replay must revoke whole token family');
    await service.revokeToken({
      clientId,
      clientSecret: client.rawSecret,
      token: rotated.access_token,
      tokenTypeHint: 'access_token',
    });
    const access = await repository.findAccessTokenByHash(sha(rotated.access_token));
    assert.ok(access?.revoked_at);
  } finally {
    await db.close();
  }
});
