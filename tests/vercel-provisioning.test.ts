import test from 'node:test';
import assert from 'node:assert/strict';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { provisionPreviewDatabase } from '../src/deployment/previewProvisioning';
import { createVercelPreviewHandler } from '../src/deployment/vercelPreview';
import type { DeploymentEnvironment } from '../src/deployment/profile';

const environment: DeploymentEnvironment = {
  VERCEL_ENV: 'preview',
  VERCEL_PREVIEW_ENABLED: 'true',
  DEPLOYMENT_MODE: 'vercel',
  STORAGE_DRIVER: 'libsql',
  EXECUTION_BACKEND: 'sandbox',
  SESSION_SECRET: 'test-provision-stable-key-abcdefghijklmnopqrstuvwxyz',
  MCP_PUBLIC_BASE_URL: 'https://preview.example.invalid',
  TURSO_DATABASE_URL: 'libsql://disposable-test.example.invalid',
  TURSO_AUTH_TOKEN: 'fake-test-token',
  VERCEL_PREVIEW_PROBE_TOKEN: 'test-only-preview-probe-token-0123456789',
  VERCEL_OWNER_CLAIM_TOKEN: 'test-owner-proof-only-not-real-abcdefghijklmnopqrstuvwxyz',
  VERCEL_PREVIEW_PROVISION_ACK: 'yes-create-disposable-preview-schema',
  VERCEL_PREVIEW_PROVISION_CONFIRM_HOST: 'disposable-test.example.invalid',
};

void test('preview provisioning refuses production, bad host and no explicit acknowledgement', async () => {
  const configs: DeploymentEnvironment[] = [
    { ...environment, VERCEL_ENV: 'production' },
    { ...environment, VERCEL_PREVIEW_PROVISION_CONFIRM_HOST: 'production.example.invalid' },
    { ...environment, VERCEL_PREVIEW_PROVISION_ACK: '' },
    { ...environment, VERCEL_OWNER_CLAIM_TOKEN: '' },
    { ...environment, TURSO_DATABASE_URL: 'file:/tmp/do-not-write.db' },
  ];
  for (const config of configs) {
    let constructed = false;
    await assert.rejects(
      () =>
        provisionPreviewDatabase(config, () => {
          constructed = true;
          return Promise.reject(new Error('No DB should be opened'));
        }),
      /VERCEL_PREVIEW/,
    );
    assert.equal(constructed, false);
  }
});

void test('provisioning disposable schema is idempotent and read-only preview becomes ready', async () => {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: ':memory:' });
  const db = new LibsqlAdapter(client);
  let opens = 0;
  const factory = () => {
    opens++;
    return Promise.resolve(db);
  };
  try {
    const first = await provisionPreviewDatabase(environment, factory);
    assert.deepEqual(first, { appliedMigrations: 13, schemaReady: true, previewOnly: true });
    const second = await provisionPreviewDatabase(environment, factory);
    assert.deepEqual(second, { appliedMigrations: 0, schemaReady: true, previewOnly: true });
    const handler = createVercelPreviewHandler(environment, factory);
    const response = await handler(
      new Request('https://preview.example.invalid/api/preview', {
        headers: { authorization: 'Bearer ' + environment.VERCEL_PREVIEW_PROBE_TOKEN },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { mcpAvailable: boolean }).mcpAvailable, false);
    assert.equal(opens, 3);
  } finally {
    client.close();
  }
});
