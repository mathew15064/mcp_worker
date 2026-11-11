import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { provisionPreviewDatabase } from '../src/deployment/previewProvisioning';
import { createPreviewOAuthRuntime } from '../src/deployment/vercelOAuthRuntime';
import { PreviewOwnerClaimError } from '../src/deployment/previewOwnerClaim';
import type { DeploymentEnvironment } from '../src/deployment/profile';

const proof = 'test-owner-proof-with-adequate-entropy-abcdefghijklmno';
const password = 'test-only-strong-credential-p4-do-not-use-on-production';
const env: DeploymentEnvironment = {
  VERCEL_ENV: 'preview',
  VERCEL_PREVIEW_ENABLED: 'true',
  DEPLOYMENT_MODE: 'vercel',
  STORAGE_DRIVER: 'libsql',
  EXECUTION_BACKEND: 'sandbox',
  SESSION_SECRET: 'test-owner-claim-stable-session-secret-for-tests',
  MCP_PUBLIC_BASE_URL: 'https://preview.example.invalid',
  TURSO_DATABASE_URL: 'libsql://disposable-owner.example.invalid',
  TURSO_AUTH_TOKEN: 'dummy-token',
  VERCEL_PREVIEW_PROBE_TOKEN: 'test-owner-preview-probe-0123456789',
  VERCEL_OWNER_CLAIM_TOKEN: proof,
  VERCEL_PREVIEW_PROVISION_ACK: 'yes-create-disposable-preview-schema',
  VERCEL_PREVIEW_PROVISION_CONFIRM_HOST: 'disposable-owner.example.invalid',
};

const badCode = (expected: string) => (error: unknown) =>
  error instanceof PreviewOwnerClaimError && error.code === expected;

void test('claim requires configured secret and never writes when proof or password is invalid', async () => {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: ':memory:' });
  const db = new LibsqlAdapter(client);
  try {
    await assert.rejects(
      () =>
        provisionPreviewDatabase({ ...env, VERCEL_OWNER_CLAIM_TOKEN: '' }, () =>
          Promise.resolve(db),
        ),
      /VERCEL_PREVIEW_INVALID_CONFIGURATION/,
    );
    await provisionPreviewDatabase(env, () => Promise.resolve(db));
    const runtime = await createPreviewOAuthRuntime(env, () => Promise.resolve(db));
    await assert.rejects(
      () =>
        runtime.owner.claim({
          proof: 'incorrect-test-proof',
          username: 'review-owner',
          password,
        }),
      badCode('OWNER_CLAIM_DENIED'),
    );
    await assert.rejects(
      () =>
        runtime.owner.claim({
          proof,
          username: 'review-owner',
          password: 'short',
        }),
      badCode('OWNER_CLAIM_INVALID_INPUT'),
    );
    const count = await db.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin'",
    );
    assert.equal(Number(count?.count), 0);
    const claims = await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM preview_owner_claims',
    );
    assert.equal(Number(claims?.count), 0);
  } finally {
    client.close();
  }
});

void test('owner claim is atomic once, persists across isolated runtimes and invalidates stale sessions', async () => {
  const { createClient } = await import('@libsql/client');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp_owner_claim_'));
  const url = `file:${path.join(directory, 'owner.sqlite')}`;
  const writer = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  const factory = () =>
    Promise.resolve(new LibsqlAdapter(createClient({ url }), { ownsClient: true }));
  let first: Awaited<ReturnType<typeof createPreviewOAuthRuntime>> | null = null;
  let second: Awaited<ReturnType<typeof createPreviewOAuthRuntime>> | null = null;
  try {
    await writer.exec('PRAGMA journal_mode=WAL');
    await writer.exec('PRAGMA foreign_keys=ON');
    await provisionPreviewDatabase(env, factory);
    first = await createPreviewOAuthRuntime(env, factory);
    second = await createPreviewOAuthRuntime(env, factory);
    const claimed = await first.owner.claim({ proof, username: 'review-owner', password });
    assert.deepEqual(claimed, {
      id: 'preview-owner',
      username: 'review-owner',
      role: 'admin',
      session_version: 1,
      auth_source: 'libsql-preview',
    });
    const stored = await second.adapter.queryOne<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id='preview-owner'",
    );
    assert.ok(stored);
    assert.notEqual(stored.password_hash, password);
    const other = second;
    const owner = await other.owner.authenticate('review-owner', password);
    assert.deepEqual(owner, claimed);
    assert.equal(await first.owner.authenticate('review-owner', 'wrong-password'), null);
    assert.equal(await first.owner.authenticate('unknown', password), null);
    const session = {
      userId: owner.id,
      role: 'admin',
      sessionVersion: owner.session_version,
      authSource: owner.auth_source,
    };
    assert.deepEqual(await first.owner.currentIdentity(session), claimed);
    assert.equal(await second.owner.currentIdentity({ ...session, authSource: 'env' }), null);
    assert.equal(await second.owner.currentIdentity({ ...session, sessionVersion: 0 }), null);
    await assert.rejects(
      () => other.owner.claim({ proof, username: 'attacker', password }),
      badCode('OWNER_ALREADY_CLAIMED'),
    );
    const counts = await second.adapter.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users WHERE role='admin'",
    );
    assert.equal(Number(counts?.count), 1);
    await writer.execute(
      "UPDATE users SET session_version=session_version+1 WHERE id='preview-owner'",
    );
    assert.equal(await second.owner.currentIdentity(session), null);
  } finally {
    await first?.close();
    await second?.close();
    await writer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

void test('two simultaneous owner claims never create two Admin accounts', async () => {
  const { createClient } = await import('@libsql/client');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp_owner_claim_race_'));
  const url = `file:${path.join(directory, 'race.sqlite')}`;
  const firstDb = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  const secondDb = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  let a: Awaited<ReturnType<typeof createPreviewOAuthRuntime>> | null = null;
  let b: Awaited<ReturnType<typeof createPreviewOAuthRuntime>> | null = null;
  try {
    await firstDb.exec('PRAGMA journal_mode=WAL');
    await provisionPreviewDatabase(env, () =>
      Promise.resolve(new LibsqlAdapter(createClient({ url }), { ownsClient: true })),
    );
    a = await createPreviewOAuthRuntime(env, () => Promise.resolve(firstDb));
    b = await createPreviewOAuthRuntime(env, () => Promise.resolve(secondDb));
    const results = await Promise.allSettled([
      a.owner.claim({ proof, username: 'first-owner', password }),
      b.owner.claim({ proof, username: 'second-owner', password }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    const rows = await firstDb.queryAll<{ id: string; username: string }>(
      "SELECT id, username FROM users WHERE role='admin'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'preview-owner');
    const claimed = await firstDb.queryAll('SELECT * FROM preview_owner_claims');
    assert.equal(claimed.length, 1);
  } finally {
    await a?.close();
    await b?.close();
    await firstDb.close();
    await secondDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
