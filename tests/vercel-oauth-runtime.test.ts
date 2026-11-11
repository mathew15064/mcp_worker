import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionData } from 'express-session';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { MigrationRunner } from '../src/db/migrationRunner';
import {
  createPreviewOAuthRuntime,
  buildPreviewOAuthPolicy,
} from '../src/deployment/vercelOAuthRuntime';
import { provisionPreviewDatabase } from '../src/deployment/previewProvisioning';
import type { DeploymentEnvironment } from '../src/deployment/profile';

const environment: DeploymentEnvironment = {
  VERCEL_ENV: 'preview',
  VERCEL_PREVIEW_ENABLED: 'true',
  DEPLOYMENT_MODE: 'vercel',
  STORAGE_DRIVER: 'libsql',
  EXECUTION_BACKEND: 'sandbox',
  SESSION_SECRET: 'test-oauth-runtime-stable-session-secret-for-ci',
  MCP_PUBLIC_BASE_URL: 'https://preview.example.invalid',
  TURSO_DATABASE_URL: 'libsql://disposable-test.example.invalid',
  TURSO_AUTH_TOKEN: 'test-only-not-real',
  VERCEL_PREVIEW_PROBE_TOKEN: 'test-oauth-runtime-probe-token-0123456789',
  VERCEL_OWNER_CLAIM_TOKEN: 'test-owner-proof-only-not-real-abcdefghijklmnopqrstuvwxyz',
  VERCEL_PREVIEW_PROVISION_ACK: 'yes-create-disposable-preview-schema',
  VERCEL_PREVIEW_PROVISION_CONFIRM_HOST: 'disposable-test.example.invalid',
};

type Runtime = Awaited<ReturnType<typeof createPreviewOAuthRuntime>>;

function setSession(runtime: Runtime, sid: string, data: SessionData): Promise<void> {
  return new Promise((resolve, reject) =>
    runtime.sessions.set(sid, data, (error) => {
      if (error)
        reject(error instanceof Error ? error : new Error('Session store callback failed'));
      else resolve();
    }),
  );
}
function getSession(runtime: Runtime, sid: string): Promise<SessionData | null | undefined> {
  return new Promise((resolve, reject) =>
    runtime.sessions.get(sid, (error, data) => {
      if (error)
        reject(error instanceof Error ? error : new Error('Session store callback failed'));
      else resolve(data);
    }),
  );
}

void test('OAuth runtime refuses unprovisioned DB without creating tables or exposing errors', async () => {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: ':memory:' });
  let created = false;
  try {
    await assert.rejects(
      createPreviewOAuthRuntime(environment, () => {
        created = true;
        return Promise.resolve(new LibsqlAdapter(client));
      }),
      (error: unknown) =>
        error instanceof Error && error.message === 'VERCEL_PREVIEW_DATABASE_UNREADY',
    );
    assert.equal(created, true);
    const schema = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'",
    );
    assert.equal(schema.rows.length, 0);
  } finally {
    client.close();
  }
});

void test('Vercel OAuth startup never creates a missing Admin session schema', async () => {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: ':memory:' });
  const db = new LibsqlAdapter(client);
  try {
    await new MigrationRunner(db).migrate();
    const before = await db.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='admin_sessions'",
    );
    assert.equal(Number(before?.count), 0);
    await assert.rejects(
      () => createPreviewOAuthRuntime(environment, () => Promise.resolve(db)),
      /VERCEL_PREVIEW_DATABASE_UNREADY/,
    );
    const after = await db.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='admin_sessions'",
    );
    assert.equal(Number(after?.count), 0);
  } finally {
    client.close();
  }
});

void test('OAuth preview policy is immutable, strictly scoped and validates TTL overrides', () => {
  const policy = buildPreviewOAuthPolicy(environment);
  assert.equal(policy.resourceUrl, 'https://preview.example.invalid/mcp');
  assert.deepEqual(policy.supportedScopes, [
    'bot_report.read',
    'bot_report.terminal',
    'offline_access',
  ]);
  assert.ok(Object.isFrozen(policy));
  assert.equal(policy.accessTokenTtlSeconds, 900);
  assert.equal(policy.authCodeTtlSeconds, 300);
  for (const ttl of ['0', '-1', 'NaN', '30', '2147483648', 'abc']) {
    assert.throws(
      () => buildPreviewOAuthPolicy({ ...environment, MCP_ACCESS_TOKEN_TTL_SECONDS: ttl }),
      /VERCEL_PREVIEW_INVALID_CONFIGURATION/,
    );
  }
  assert.throws(
    () => buildPreviewOAuthPolicy({ ...environment, VERCEL_ENV: 'production' }),
    /VERCEL_PREVIEW_DISABLED/,
  );
});

void test('two cold-start OAuth runtimes share DB/session but never share in-memory singleton state', async () => {
  const { createClient } = await import('@libsql/client');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp_p4_oauth_scope_'));
  const url = `file:${path.join(directory, 'preview.sqlite')}`;
  const opened: LibsqlAdapter[] = [];
  const factory = () => {
    const adapter = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
    opened.push(adapter);
    return Promise.resolve(adapter);
  };
  let a: Runtime | null = null;
  let b: Runtime | null = null;
  try {
    await provisionPreviewDatabase(environment, factory);
    a = await createPreviewOAuthRuntime(environment, factory);
    b = await createPreviewOAuthRuntime(environment, factory);
    const second = b;
    assert.notEqual(a.adapter, b.adapter);
    assert.notEqual(a.repository, b.repository);
    assert.notEqual(a.oauth, b.oauth);
    assert.equal(a.sessionMiddleware instanceof Function, true);
    assert.equal(a.policy.resourceUrl, environment.MCP_PUBLIC_BASE_URL + '/mcp');

    const session: SessionData = {
      cookie: { originalMaxAge: 60000, maxAge: 60000, secure: true, httpOnly: true, path: '/' },
      userId: 'preview-admin',
      role: 'admin',
    };
    await setSession(a, 'session-owned-by-preview', session);
    assert.equal((await getSession(b, 'session-owned-by-preview'))?.userId, 'preview-admin');
    const record = await b.adapter.queryOne<{ ciphertext: string; sid_hash: string }>(
      'SELECT sid_hash, ciphertext FROM admin_sessions LIMIT 1',
    );
    assert.ok(record);
    assert.notEqual(record.sid_hash, 'session-owned-by-preview');
    assert.doesNotMatch(record.ciphertext, /preview-admin/);

    const client = await a.oauth.registerClient({
      displayName: 'scoped-test-client',
      redirectUris: ['https://callback.example.invalid/oauth'],
      allowedScopes: ['bot_report.read', 'offline_access'],
    });
    if (!client.client) throw new Error('Expected a new client');
    const clientId = client.client.client_id;
    assert.ok(await b.repository.findClientByClientId(clientId));
    const verifier = 'p4-abcdefghijklmnopqrstuvwxyz-0123456789';
    const code = await a.oauth.issueAuthorizationCode({
      clientId,
      userId: 'preview-admin',
      principalId: client.client.principal_id,
      redirectUri: 'https://callback.example.invalid/oauth',
      resource: a.policy.resourceUrl,
      scopes: ['bot_report.read', 'offline_access'],
      codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    });
    const issued = await b.oauth.exchangeAuthorizationCode({
      clientId,
      clientSecret: client.rawSecret,
      code,
      redirectUri: 'https://callback.example.invalid/oauth',
      resource: b.policy.resourceUrl,
      codeVerifier: verifier,
    });
    if (!issued.refresh_token) throw new Error('Expected offline_access refresh token');
    const issuedRefreshToken = issued.refresh_token;
    const refreshed = await a.oauth.exchangeRefreshToken({
      clientId,
      clientSecret: client.rawSecret,
      refreshToken: issued.refresh_token,
      resource: a.policy.resourceUrl,
    });
    await assert.rejects(
      () =>
        second.oauth.exchangeRefreshToken({
          clientId,
          clientSecret: client.rawSecret,
          refreshToken: issuedRefreshToken,
          resource: second.policy.resourceUrl,
        }),
      { error: 'invalid_grant' },
    );
    await b.oauth.revokeToken({
      clientId,
      clientSecret: client.rawSecret,
      token: refreshed.access_token,
      tokenTypeHint: 'access_token',
    });
    const tokenHash = crypto.createHash('sha256').update(refreshed.access_token).digest('hex');
    assert.ok((await a.repository.findAccessTokenByHash(tokenHash))?.revoked_at);
    assert.equal(
      (await b.adapter.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM migrations'))
        ?.count,
      13,
    );
  } finally {
    await a?.close();
    await b?.close();
    for (const adapter of opened) await adapter.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
