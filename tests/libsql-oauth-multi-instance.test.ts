import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { MigrationRunner } from '../src/db/migrationRunner';
import oauthRepository from '../src/repositories/mcpOAuthRepository';
import oauthService from '../src/services/mcpOAuthService';
import mcpConfig from '../src/config/mcpConfig';

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

void test('OAuth access, refresh, revoke and replay state are shared across independent libSQL connections', async () => {
  const { createClient } = await import('@libsql/client');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp_worker_libsql_multi_oauth_'));
  const url = `file:${path.join(directory, 'oauth.sqlite')}`;
  const first = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  const second = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  try {
    await first.exec('PRAGMA journal_mode=WAL');
    await first.exec('PRAGMA foreign_keys=ON');
    await second.exec('PRAGMA foreign_keys=ON');
    await new MigrationRunner(first).migrate();
    const repoA = new oauthRepository.McpOAuthRepository(first);
    const repoB = new oauthRepository.McpOAuthRepository(second);
    const serviceA = new oauthService.McpOAuthService(repoA, mcpConfig);
    const serviceB = new oauthService.McpOAuthService(repoB, mcpConfig);
    const redirectUri = 'https://example.invalid/callback';
    const client = await serviceA.registerClient({
      displayName: 'multi-instance libsql',
      redirectUris: [redirectUri],
      allowedScopes: ['bot_report.read', 'offline_access'],
    });
    assert.ok(client.client);
    const clientId = client.client.client_id;
    assert.ok(await repoB.findClientByClientId(clientId));
    const verifier = 'multi-instance-pkce-abcdefghijklmnopqrstuvwxyz-0123456789';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const code = await serviceA.issueAuthorizationCode({
      clientId,
      userId: 'test-admin',
      principalId: client.client.principal_id,
      redirectUri,
      resource: mcpConfig.resourceUrl,
      scopes: ['bot_report.read', 'offline_access'],
      codeChallenge: challenge,
    });
    const tokens = await serviceB.exchangeAuthorizationCode({
      clientId,
      clientSecret: client.rawSecret,
      code,
      redirectUri,
      resource: mcpConfig.resourceUrl,
      codeVerifier: verifier,
    });
    assert.ok(await repoA.findAccessTokenByHash(hash(tokens.access_token)));
    if (!tokens.refresh_token) throw new Error('Expected offline_access refresh token');
    const rotated = await serviceA.exchangeRefreshToken({
      clientId,
      clientSecret: client.rawSecret,
      refreshToken: tokens.refresh_token,
      resource: mcpConfig.resourceUrl,
    });
    await assert.rejects(
      serviceB.exchangeRefreshToken({
        clientId,
        clientSecret: client.rawSecret,
        refreshToken: tokens.refresh_token,
        resource: mcpConfig.resourceUrl,
      }),
      { error: 'invalid_grant' },
    );
    await serviceA.revokeToken({
      clientId,
      clientSecret: client.rawSecret,
      token: rotated.access_token,
      tokenTypeHint: 'access_token',
    });
    assert.ok((await repoB.findAccessTokenByHash(hash(rotated.access_token)))?.revoked_at);
  } finally {
    await first.close();
    await second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
