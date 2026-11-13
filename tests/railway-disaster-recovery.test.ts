import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  sandboxRoot,
  makeCertificate,
  makeSandbox,
  startSandbox,
  stopSandbox,
  cleanupRoot,
  setupOwner,
  loginOwner,
  forwarded,
  rpc,
  type Sandbox,
} from '../scripts/verify-railway-harness';

const restoreScript = path.join(process.cwd(), 'scripts/verify-railway-offvolume-restore.cjs');
type BackupInfo = { path: string; bytes: number };
function restore(source: string, destination: string) {
  return spawnSync(process.execPath, [restoreScript, source, destination], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', W3_SANDBOX_ONLY: '1' },
    encoding: 'utf8',
    timeout: 12000,
  });
}
function snapshot(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const marker = (
      db.prepare('SELECT value FROM system_settings WHERE key=?').get('recovery.marker') as
        { value?: string } | undefined
    )?.value;
    const owner = (
      db
        .prepare('SELECT value FROM system_settings WHERE key=?')
        .get('bootstrap.admin_password_hash') as { value?: string } | undefined
    )?.value;
    const sessions = db.prepare('SELECT sess,expired FROM sessions').all() as {
      sess: string;
      expired: number;
    }[];
    return {
      quickCheck: db.pragma('quick_check', { simple: true }),
      schema: db.prepare('SELECT version FROM railway_schema_versions').all() as {
        version: string;
      }[],
      marker,
      ownerPresent: Boolean(owner && /^\$2/.test(owner)),
      sessions: sessions.length,
      validAdminSession: sessions.some(
        (row) =>
          row.expired > Date.now() &&
          (JSON.parse(row.sess) as { userId?: string }).userId === 'env-admin',
      ),
      clients: (db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_clients').get() as { n: number }).n,
      workers: (db.prepare('SELECT COUNT(*) AS n FROM workers').get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
}
async function assertSetupLocked(s: Sandbox) {
  const response = await fetch(s.http + '/setup', { headers: forwarded, redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login');
}

void test('online WAL backup goes off-volume, restores independent sandbox and survives restart', async (t) => {
  const root = sandboxRoot();
  const cert = makeCertificate(root);
  const source = makeSandbox(root, 'recovery-original', cert);
  const restored = makeSandbox(root, 'recovery-restored', cert, { secret: source.secret });
  const wrongSecret = makeSandbox(root, 'recovery-wrong-secret', cert);
  const offVolume = path.join(root, 'off-volume');
  fs.mkdirSync(offVolume, { mode: 0o700 });
  const backupFile = path.join(offVolume, 'snapshot.sqlite');
  const password = 'Isolated-DR-Owner-2026!';
  t.after(async () => {
    await Promise.all([stopSandbox(source), stopSandbox(restored), stopSandbox(wrongSecret)]);
    cleanupRoot(root);
  });
  await startSandbox(source);
  assert.equal(await setupOwner(source, password), 303);
  const login = await loginOwner(source, password);
  assert.equal(login.status, 302);
  const client = await rpc<{ client: { client_id: string } }>(source, 'oauthRegister', {
    displayName: 'Recovery fixture client',
    principalId: 'principal:recovery',
    redirectUris: ['http://localhost:40000/oauth/callback'],
    allowedScopes: ['bot_report.read', 'offline_access'],
  });
  assert.ok(client.client.client_id);
  const enrollment = await rpc<{ token: string }>(source, 'enrollmentToken');
  const key = crypto.generateKeyPairSync('ed25519');
  const enrolled = await fetch(source.http + '/worker/v1/enroll', {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/json' },
    body: JSON.stringify({
      token: enrollment.token,
      name: 'Recovery-Worker',
      public_key: key.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      capabilities: ['workspace.exec'],
    }),
  });
  assert.equal(enrolled.status, 201);
  await rpc(source, 'marker', { key: 'recovery.marker', value: 'before-online-backup' });
  assert.notEqual(path.dirname(backupFile), source.volume);
  const backup = await rpc<BackupInfo>(source, 'backup', { target: backupFile });
  assert.ok(backup.bytes > 4096);
  assert.equal(backup.path, backupFile);
  const backupHash = crypto.createHash('sha256').update(fs.readFileSync(backupFile)).digest('hex');
  assert.equal(snapshot(backupFile).quickCheck, 'ok');
  await rpc(source, 'marker', { key: 'recovery.marker', value: 'after-online-backup' });
  assert.equal(snapshot(backupFile).marker, 'before-online-backup');
  await stopSandbox(source);

  const copied = restore(backupFile, restored.volume);
  assert.equal(copied.status, 0, copied.stderr);
  const report = JSON.parse(copied.stdout) as {
    status: string;
    sha256: string;
    bytes: number;
    ownerPresent: boolean;
    sessions: number;
    clients: number;
    workers: number;
    schema: string;
  };
  assert.equal(report.status, 'RESTORED_SANDBOX_ONLY');
  assert.equal(report.sha256, backupHash);
  assert.equal(report.bytes, backup.bytes);
  assert.equal(report.ownerPresent, true);
  assert.ok(report.sessions >= 1 && report.clients >= 1 && report.workers >= 1);
  assert.equal(report.schema, '2026-11-12-initial');
  const state = snapshot(restored.dbPath);
  assert.deepEqual(state.schema, [{ version: '2026-11-12-initial' }]);
  assert.equal(state.quickCheck, 'ok');
  assert.equal(state.marker, 'before-online-backup');
  assert.equal(state.ownerPresent, true);
  assert.equal(state.validAdminSession, true);
  assert.ok(state.clients >= 1 && state.workers >= 1);

  await startSandbox(restored);
  await assertSetupLocked(restored);
  assert.equal((await fetch(restored.http + '/readyz', { headers: forwarded })).status, 200);
  assert.equal(
    (
      await fetch(restored.http + '/admin', {
        headers: { ...forwarded, cookie: login.sid },
        redirect: 'manual',
      })
    ).status,
    200,
    'Same-secret restore must preserve policy-valid admin sessions',
  );
  await stopSandbox(restored);
  await startSandbox(restored);
  await assertSetupLocked(restored);
  assert.equal(snapshot(restored.dbPath).marker, 'before-online-backup');

  // A mismatched secret must never authenticate a previously signed session.
  assert.notEqual(wrongSecret.secret, source.secret);
  const extra = restore(backupFile, wrongSecret.volume);
  assert.equal(extra.status, 0, extra.stderr);
  await startSandbox(wrongSecret);
  const stolenSession = await fetch(wrongSecret.http + '/admin', {
    headers: { ...forwarded, cookie: login.sid },
    redirect: 'manual',
  });
  assert.notEqual(stolenSession.status, 200);
  await assertSetupLocked(wrongSecret);
  assert.equal(snapshot(wrongSecret.dbPath).marker, 'before-online-backup');
});

void test('missing, corrupt and unsupported backup refusal never writes target; corrupt live database fails closed', async (t) => {
  const root = sandboxRoot();
  const cert = makeCertificate(root);
  const source = makeSandbox(root, 'corrupt-source', cert);
  const empty = makeSandbox(root, 'missing-restore', cert);
  const corruptTarget = makeSandbox(root, 'corrupt-restore', cert);
  const unknownTarget = makeSandbox(root, 'unknown-schema-restore', cert);
  t.after(async () => {
    await Promise.all([stopSandbox(source), stopSandbox(empty), stopSandbox(corruptTarget)]);
    cleanupRoot(root);
  });
  const missingFile = path.join(root, 'off-volume-missing.sqlite');
  const absent = restore(missingFile, empty.volume);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /source backup missing/);
  assert.deepEqual(fs.readdirSync(empty.volume), []);
  const broken = path.join(root, 'bad-backup.sqlite');
  fs.writeFileSync(broken, 'SQLite corruption fixture; not a live database', { mode: 0o600 });
  const rejected = restore(broken, corruptTarget.volume);
  assert.notEqual(rejected.status, 0);
  assert.deepEqual(fs.readdirSync(corruptTarget.volume), []);

  await startSandbox(source);
  assert.equal(await setupOwner(source, 'Correct-Owner-Password-2026!'), 303);
  const valid = path.join(root, 'valid-snapshot.sqlite');
  await rpc(source, 'backup', { target: valid });
  await stopSandbox(source);
  const tampered = path.join(root, 'unknown-schema.sqlite');
  fs.copyFileSync(valid, tampered);
  const db = new Database(tampered);
  db.prepare('UPDATE railway_schema_versions SET version=?').run('2099-unsupported');
  db.close();
  const unknown = restore(tampered, unknownTarget.volume);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unsupported schema version/);
  assert.deepEqual(fs.readdirSync(unknownTarget.volume), []);

  // Independent corruption of the *live sandbox copy* must reject startup and not wipe bytes.
  const dbBytes = Buffer.from('not a SQLite file');
  fs.writeFileSync(source.dbPath, dbBytes);
  await assert.rejects(startSandbox(source));
  assert.deepEqual(fs.readFileSync(source.dbPath), dbBytes);
});

void test('read-only sandbox volume rejects startup without overwriting SQLite', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('Run in non-root CI/Docker: root can bypass discretionary read-only mode');
    return;
  }
  const root = sandboxRoot();
  const cert = makeCertificate(root);
  const s = makeSandbox(root, 'readonly-source', cert);
  t.after(async () => {
    fs.chmodSync(s.volume, 0o700);
    await stopSandbox(s);
    cleanupRoot(root);
  });
  await startSandbox(s);
  await stopSandbox(s);
  const before = fs.readFileSync(s.dbPath);
  fs.chmodSync(s.volume, 0o500);
  await assert.rejects(startSandbox(s));
  assert.deepEqual(fs.readFileSync(s.dbPath), before);
});
