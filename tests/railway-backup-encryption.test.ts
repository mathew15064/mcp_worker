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
} from '../scripts/verify-railway-harness';

const backupCli = path.join(process.cwd(), 'dist/scripts/backup-db.js');
const restoreCli = path.join(process.cwd(), 'scripts/verify-railway-offvolume-restore.cjs');
const offsiteCli = path.join(process.cwd(), 'scripts/railway-offsite-simulate.cjs');

function exportEncrypted(
  dbPath: string,
  volume: string,
  out: string,
  keyFile: string,
  stage: string,
) {
  return spawnSync(process.execPath, [backupCli], {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      NODE_ENV: 'test',
      DATABASE_PATH: dbPath,
      RAILWAY_VOLUME_MOUNT_PATH: volume,
      BACKUP_EXPORT_DIR: out,
      BACKUP_ENCRYPTION_KEY_FILE: keyFile,
      BACKUP_STAGING_DIR: stage,
      BACKUP_ALLOW_LOGICAL_VOLUME_TEST_ONLY: '1',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}
function sandboxRestore(source: string, destination: string, keyFile?: string) {
  return spawnSync(process.execPath, [restoreCli, source, destination], {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      W3_SANDBOX_ONLY: '1',
      ...(keyFile ? { W3_BACKUP_KEY_FILE: keyFile } : {}),
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}
function simulateTransfer(
  operation: string,
  source: string,
  directory: string,
  logical = true,
  keyEnv = false,
) {
  return spawnSync(process.execPath, [offsiteCli, operation, source, directory], {
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      T04_OFFSITE_SIMULATION_ONLY: '1',
      ...(logical ? { T04_LOGICAL_STORE_TEST_ONLY: '1' } : {}),
      ...(keyEnv ? { W3_BACKUP_KEY_FILE: '/NEVER-PASS-TO-STORAGE' } : {}),
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}
function keyAt(file: string) {
  fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
}
function empty(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

void test('AES-256-GCM fixture backup decrypts and restores identity, session, OAuth and Worker across restart', async (t) => {
  const root = sandboxRoot();
  const cert = makeCertificate(root);
  const a = makeSandbox(root, 'encrypted-original', cert);
  const b = makeSandbox(root, 'encrypted-restored', cert, { secret: a.secret });
  const exportDir = empty(root, 'off-volume-encrypted');
  const stage = fs.mkdtempSync('/dev/shm/t4-encrypted-stage-');
  fs.chmodSync(stage, 0o700);
  const keys = empty(root, 'separate-key-custody');
  const keyFile = path.join(keys, 'private-raw-key');
  keyAt(keyFile);
  t.after(async () => {
    await Promise.all([stopSandbox(a), stopSandbox(b)]);
    cleanupRoot(root);
    fs.rmSync(stage, { recursive: true, force: true });
  });

  await startSandbox(a);
  assert.equal(await setupOwner(a, 'Encryption-Owner-Test-2026!'), 303);
  const login = await loginOwner(a, 'Encryption-Owner-Test-2026!');
  assert.equal(login.status, 302);
  await rpc(a, 'marker', { key: 'recovery.marker', value: 'encrypted-before' });
  const client = await rpc<{ client: { client_id: string } }>(a, 'oauthRegister', {
    displayName: 'Encrypted OAuth fixture',
    principalId: 'principal:encrypted',
    redirectUris: ['http://localhost:40000/oauth/callback'],
    allowedScopes: ['bot_report.read', 'offline_access'],
  });
  assert.ok(client.client.client_id);
  const enrollment = await rpc<{ token: string }>(a, 'enrollmentToken');
  const pair = crypto.generateKeyPairSync('ed25519');
  const registered = await fetch(a.http + '/worker/v1/enroll', {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/json' },
    body: JSON.stringify({
      token: enrollment.token,
      name: 'Encrypted Recovery Worker',
      public_key: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      capabilities: ['workspace.exec'],
    }),
  });
  assert.equal(registered.status, 201);

  const exported = exportEncrypted(a.dbPath, a.volume, exportDir, keyFile, stage);
  assert.equal(exported.status, 0, exported.stderr);
  const backup = JSON.parse(exported.stdout) as {
    status: string;
    path: string;
    manifest: string;
    sha256: string;
    encrypted: boolean;
  };
  assert.equal(backup.status, 'BACKUP_EXPORTED_ENCRYPTED_LOCAL');
  assert.deepEqual(fs.readdirSync(stage), [], 'no temporary plaintext survives export');
  assert.equal(backup.encrypted, true);
  assert.ok(backup.path.endsWith('.sqlite.enc'));
  assert.deepEqual(
    fs.readdirSync(exportDir).sort(),
    [path.basename(backup.path), path.basename(backup.manifest)].sort(),
  );
  assert.notEqual(fs.readFileSync(backup.path).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  const manifest = JSON.parse(fs.readFileSync(backup.manifest, 'utf8')) as {
    format: string;
    sha256: string;
    plaintextSha256: string;
    encryption: { algorithm: string; nonce: string; tag: string };
    authentication: { algorithm: string; tag: string };
    plaintextBytes: number;
  };
  assert.equal(manifest.format, 'bot-report-sqlite-backup-encrypted-v1');
  assert.equal(manifest.encryption.algorithm, 'aes-256-gcm');
  assert.equal(manifest.authentication.algorithm, 'hmac-sha256-hkdf-v1');
  assert.match(manifest.authentication.tag, /^[a-f0-9]{64}$/);
  assert.equal(manifest.sha256, backup.sha256);
  assert.match(manifest.plaintextSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(backup.path).mode & 0o777, 0o600);

  // Two independent simulated transfer stages: offsite object-store namespace,
  // then retrieval to an empty landing directory. Neither stage receives a key.
  const store = empty(root, 'independent-object-store-simulation');
  const landing = empty(root, 'retrieval-landing');
  const unsafeMount = simulateTransfer('deposit', backup.path, store, false);
  assert.notEqual(unsafeMount.status, 0);
  assert.match(unsafeMount.stderr, /same-mount transfer/);
  assert.deepEqual(fs.readdirSync(store), []);
  const deposit = simulateTransfer('deposit', backup.path, store);
  assert.equal(deposit.status, 0, deposit.stderr);
  const deposited = JSON.parse(deposit.stdout) as {
    status: string;
    artifact: string;
    remoteStorageVerified: boolean;
    sameMountLogicalOnly: boolean;
  };
  assert.equal(deposited.status, 'PC_SIMULATED_DEPOSIT_ONLY');
  assert.equal(deposited.remoteStorageVerified, false);
  assert.equal(deposited.sameMountLogicalOnly, true);
  assert.deepEqual(
    fs.readdirSync(store).sort(),
    [path.basename(backup.path), path.basename(backup.manifest)].sort(),
  );
  assert.equal(
    simulateTransfer('retrieve', deposited.artifact, landing, true, true).status === 0,
    false,
  );
  assert.deepEqual(fs.readdirSync(landing), []);
  const retrieval = simulateTransfer('retrieve', deposited.artifact, landing);
  assert.equal(retrieval.status, 0, retrieval.stderr);
  const retrieved = JSON.parse(retrieval.stdout) as { artifact: string; status: string };
  assert.equal(retrieved.status, 'PC_SIMULATED_RETRIEVAL_ONLY');
  assert.equal(fs.readFileSync(retrieved.artifact).equals(fs.readFileSync(backup.path)), true);
  assert.equal(fs.existsSync(path.join(store, path.basename(keyFile))), false);
  await rpc(a, 'marker', { key: 'recovery.marker', value: 'encrypted-after' });
  const restored = sandboxRestore(retrieved.artifact, b.volume, keyFile);
  assert.equal(restored.status, 0, restored.stderr);
  const report = JSON.parse(restored.stdout) as {
    status: string;
    encrypted: boolean;
    ownerPresent: boolean;
    sessions: number;
    clients: number;
    workers: number;
  };
  assert.equal(report.status, 'RESTORED_SANDBOX_ONLY');
  assert.equal(report.encrypted, true);
  assert.equal(report.ownerPresent, true);
  assert.ok(report.sessions >= 1 && report.clients >= 1 && report.workers >= 1);
  const copied = new Database(b.dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(copied.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(
      (
        copied.prepare("SELECT value FROM system_settings WHERE key='recovery.marker'").get() as {
          value: string;
        }
      ).value,
      'encrypted-before',
    );
    assert.equal(
      (
        copied
          .prepare('SELECT COUNT(*) AS n FROM mcp_oauth_clients WHERE client_id=?')
          .get(client.client.client_id) as { n: number }
      ).n,
      1,
    );
  } finally {
    copied.close();
  }
  await startSandbox(b);
  assert.equal(
    (
      await fetch(b.http + '/admin', {
        headers: { ...forwarded, cookie: login.sid },
        redirect: 'manual',
      })
    ).status,
    200,
  );
  await stopSandbox(b);
  await startSandbox(b);
  assert.equal((await fetch(b.http + '/readyz', { headers: forwarded })).status, 200);
  assert.equal(
    (
      await fetch(b.http + '/admin', {
        headers: { ...forwarded, cookie: login.sid },
        redirect: 'manual',
      })
    ).status,
    200,
  );

  const keyLostTarget = empty(root, 'missing-key-target');
  const noKey = sandboxRestore(backup.path, keyLostTarget);
  assert.notEqual(noKey.status, 0);
  assert.match(noKey.stderr, /W3_BACKUP_KEY_FILE required/);
  assert.deepEqual(fs.readdirSync(keyLostTarget), []);

  const wrongKey = path.join(keys, 'wrong-raw-key');
  keyAt(wrongKey);
  const wrongTarget = empty(root, 'wrong-key-target');
  const wrong = sandboxRestore(backup.path, wrongTarget, wrongKey);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /authenticated manifest mismatch/);
  assert.deepEqual(fs.readdirSync(wrongTarget), []);

  const tampered = path.join(exportDir, 'tampered.sqlite.enc');
  // Use an independent sibling bundle, corrupt it and re-seal its *public* checksum.
  fs.copyFileSync(backup.path, tampered);
  const corrupted = fs.readFileSync(tampered);
  corrupted[Math.floor(corrupted.length / 2)] ^= 0x01;
  fs.writeFileSync(tampered, corrupted, { mode: 0o600 });
  const alteredManifest = {
    ...manifest,
    file: path.basename(tampered),
    bytes: corrupted.length,
    sha256: crypto.createHash('sha256').update(corrupted).digest('hex'),
  };
  const alteredPayload = Object.fromEntries(
    Object.entries(alteredManifest).filter(([field]) => field !== 'authentication'),
  );
  const authKey = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      fs.readFileSync(keyFile),
      Buffer.from('bot-report-railway-backup-v1'),
      Buffer.from('manifest-authentication-v1'),
      32,
    ),
  );
  alteredManifest.authentication = {
    algorithm: 'hmac-sha256-hkdf-v1',
    tag: crypto
      .createHmac('sha256', authKey)
      .update(JSON.stringify(alteredPayload), 'utf8')
      .digest('hex'),
  };
  authKey.fill(0);
  fs.writeFileSync(tampered + '.manifest.json', JSON.stringify(alteredManifest), { mode: 0o600 });
  const corruptTarget = empty(root, 'ciphertext-tamper-target');
  const rejected = sandboxRestore(tampered, corruptTarget, keyFile);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /authenticated decryption failed/);
  assert.deepEqual(fs.readdirSync(corruptTarget), []);

  // Valid-looking metadata changes are rejected by the keyed manifest MAC.
  const metaModified = path.join(exportDir, 'modified-manifest.sqlite.enc');
  fs.copyFileSync(backup.path, metaModified);
  const changedMetadata = {
    ...manifest,
    file: path.basename(metaModified),
    plaintextSha256: '0'.repeat(64),
  };
  fs.writeFileSync(metaModified + '.manifest.json', JSON.stringify(changedMetadata), {
    mode: 0o600,
  });
  const metadataTarget = empty(root, 'manifest-tamper-target');
  const metadataResult = sandboxRestore(metaModified, metadataTarget, keyFile);
  assert.notEqual(metadataResult.status, 0);
  assert.match(metadataResult.stderr, /authenticated manifest mismatch/);
  assert.deepEqual(fs.readdirSync(metadataTarget), []);

  const plaintextFile = path.join(root, 'forbidden-plaintext.sqlite');
  fs.writeFileSync(plaintextFile, 'SQLite format 3');
  const plaintextStore = empty(root, 'plaintext-store-refusal');
  assert.notEqual(simulateTransfer('deposit', plaintextFile, plaintextStore).status, 0);
  assert.deepEqual(fs.readdirSync(plaintextStore), []);
  const occupiedStore = empty(root, 'occupied-offsite-store');
  fs.writeFileSync(path.join(occupiedStore, 'some-existing-object'), 'preserve');
  assert.notEqual(simulateTransfer('deposit', backup.path, occupiedStore).status, 0);
  assert.equal(
    fs.readFileSync(path.join(occupiedStore, 'some-existing-object'), 'utf8'),
    'preserve',
  );
  const linkedStore = path.join(root, 'linked-object-store');
  fs.symlinkSync(store, linkedStore);
  assert.notEqual(simulateTransfer('deposit', backup.path, linkedStore).status, 0);

  const linked = path.join(root, 'linked-backup.sqlite.enc');
  fs.symlinkSync(backup.path, linked);
  const linkTarget = empty(root, 'linked-target');
  assert.notEqual(sandboxRestore(linked, linkTarget, keyFile).status, 0);
  assert.deepEqual(fs.readdirSync(linkTarget), []);

  const occupied = empty(root, 'occupied-target');
  fs.writeFileSync(path.join(occupied, 'bot_report.sqlite'), 'NEVER_REPLACE');
  assert.notEqual(sandboxRestore(backup.path, occupied, keyFile).status, 0);
  assert.equal(fs.readFileSync(path.join(occupied, 'bot_report.sqlite'), 'utf8'), 'NEVER_REPLACE');

  // A symlinked/disk staging directory must never enable encrypted export.
  const diskStage = empty(root, 'not-tmpfs');
  const badStage = exportEncrypted(a.dbPath, a.volume, exportDir, keyFile, diskStage);
  assert.notEqual(badStage.status, 0);
  assert.match(badStage.stderr, /private tmpfs directory/);
  const symlinkStage = path.join(root, 'stage-link');
  fs.symlinkSync(stage, symlinkStage);
  const linkedStage = exportEncrypted(a.dbPath, a.volume, exportDir, keyFile, symlinkStage);
  assert.notEqual(linkedStage.status, 0);
  assert.match(linkedStage.stderr, /private tmpfs directory/);

  const looseKey = path.join(keys, 'loose-key');
  fs.copyFileSync(keyFile, looseKey);
  fs.chmodSync(looseKey, 0o644);
  const looseTarget = empty(root, 'loose-key-target');
  assert.notEqual(sandboxRestore(backup.path, looseTarget, looseKey).status, 0);
  assert.deepEqual(fs.readdirSync(looseTarget), []);
});
