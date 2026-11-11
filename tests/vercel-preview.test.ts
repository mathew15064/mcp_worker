import test from 'node:test';
import assert from 'node:assert/strict';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { LibsqlSessionStore } from '../src/db/libsqlSessionStore';
import { MigrationRunner } from '../src/db/migrationRunner';
import { createVercelPreviewHandler, parsePreviewConfig } from '../src/deployment/vercelPreview';
import type { DeploymentEnvironment } from '../src/deployment/profile';

const env: DeploymentEnvironment = {
  VERCEL_ENV: 'preview',
  VERCEL_PREVIEW_ENABLED: 'true',
  DEPLOYMENT_MODE: 'vercel',
  STORAGE_DRIVER: 'libsql',
  EXECUTION_BACKEND: 'sandbox',
  SESSION_SECRET: 'stable-test-preview-session-key-abcdefghijklmnopqrstuvwxyz',
  MCP_PUBLIC_BASE_URL: 'https://preview.example.invalid',
  TURSO_DATABASE_URL: 'libsql://testing.example.invalid',
  TURSO_AUTH_TOKEN: 'dummy-test-only-not-real',
  VERCEL_PREVIEW_PROBE_TOKEN: 'preview-test-only-bearer-probe-0123456789',
};

const call = (handler: ReturnType<typeof createVercelPreviewHandler>, method = 'GET') =>
  handler(
    new Request('https://preview.example.invalid/api/preview', {
      method,
      headers: { authorization: 'Bearer ' + env.VERCEL_PREVIEW_PROBE_TOKEN },
    }),
  );

void test('Vercel Preview refuses production, wrong profile, missing credentials or insecure origin', async () => {
  const rejected = [
    { ...env, VERCEL_ENV: 'production' },
    { ...env, VERCEL_PREVIEW_ENABLED: 'false' },
    { ...env, DEPLOYMENT_MODE: 'selfhost' },
    { ...env, EXECUTION_BACKEND: 'durable-worker' },
    { ...env, SESSION_SECRET: 'short' },
    { ...env, VERCEL_PREVIEW_PROBE_TOKEN: 'short' },
    { ...env, MCP_PUBLIC_BASE_URL: 'http://preview.example.invalid' },
    { ...env, TURSO_DATABASE_URL: 'file:../../data/production.sqlite' },
    { ...env, TURSO_AUTH_TOKEN: '' },
  ];
  for (const environment of rejected) {
    let constructed = false;
    const handler = createVercelPreviewHandler(environment, () => {
      constructed = true;
      return Promise.reject(new Error('A rejected profile must not open a database'));
    });
    const response = await call(handler);
    assert.equal(response.status, 503);
    assert.equal(constructed, false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(((await response.json()) as { ready: boolean }).ready, false);
  }
  assert.deepEqual(parsePreviewConfig(env), {
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
});

void test('Vercel preview probe is read-only and does not leak connection secrets', async () => {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: ':memory:' });
  const adapter = new LibsqlAdapter(client);
  const captured: string[] = [];
  const handler = createVercelPreviewHandler(env, ({ url, authToken }) => {
    captured.push(url, authToken);
    return Promise.resolve(adapter);
  });
  try {
    const uninitialized = await call(handler);
    assert.equal(uninitialized.status, 503);
    await new MigrationRunner(adapter).migrate();
    const missingSession = await call(handler);
    assert.equal(missingSession.status, 503);
    const sessions = new LibsqlSessionStore({
      adapter,
      secret: env.SESSION_SECRET || '',
    });
    await sessions.initialize();
    const response = await call(handler);
    assert.equal(response.status, 200);
    const data: unknown = await response.json();
    assert.deepEqual(data, {
      ready: true,
      service: 'mcp_worker',
      preview: 'database-only',
      mcpAvailable: false,
    });
    assert.equal(captured.length, 6);
    assert.ok(!JSON.stringify(data).includes('dummy-test-only'));
    assert.equal((await call(handler, 'POST')).status, 405);
  } finally {
    client.close();
  }
});

void test('preview probe rejects anonymous requests before any DB query', async () => {
  let opened = false;
  const handler = createVercelPreviewHandler(env, () => {
    opened = true;
    return Promise.reject(new Error('Never connect for anonymous request'));
  });
  const response = await handler(new Request('https://preview.example.invalid/api/preview'));
  assert.equal(response.status, 404);
  assert.equal(opened, false);
  assert.equal(((await response.json()) as { code: string }).code, 'NOT_FOUND');
});

void test('preview route refuses an unavailable remote database without disclosing details', async () => {
  const handler = createVercelPreviewHandler(env, () =>
    Promise.reject(new Error('secret-url-or-token-must-not-appear')),
  );
  const response = await call(handler);
  assert.equal(response.status, 503);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, 'VERCEL_PREVIEW_DATABASE_UNREADY');
  assert.ok(!JSON.stringify(body).includes('secret-url-or-token'));
});
