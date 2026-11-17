import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '../..');

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

void test('release builder refuses absent version and wrong full source SHA before generating artifacts', () => {
  const absent = run('sh', ['scripts/build-worker-go.sh'], { VERSION: '', COMMIT: '' });
  assert.equal(absent.status, 2, absent.stderr);
  assert.match(absent.stderr, /release VERSION=x.y.z is required/);

  const shortCommit = run('sh', ['scripts/build-worker-go.sh'], {
    VERSION: '2.0.0',
    COMMIT: 'abc123',
  });
  assert.equal(shortCommit.status, 2);
  assert.match(shortCommit.stderr, /full 40-character lowercase Git SHA/);

  const wrongCommit = run('sh', ['scripts/build-worker-go.sh'], {
    VERSION: '2.0.0',
    COMMIT: 'f'.repeat(40),
  });
  assert.equal(wrongCommit.status, 2);
  assert.match(wrongCommit.stderr, /does not match approved release commit/);
});

void test('owner-only RSA-4096 key generator forbids source directory and key overwrite', () => {
  const blocked = run('sh', ['scripts/create-worker-signing-key.sh', path.join(root, 'worker')]);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /outside the source repository/);

  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-key-test-'));
  try {
    const first = run('sh', ['scripts/create-worker-signing-key.sh', keyDir]);
    assert.equal(first.status, 0, first.stderr);
    const privatePath = path.join(keyDir, 'private.pem');
    const publicPath = path.join(keyDir, 'public.pem');
    const fingerprint = fs.readFileSync(path.join(keyDir, 'public-spki-sha256.txt'), 'utf8').trim();
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(privatePath).mode & 0o777, 0o600);
    assert.equal(crypto.createPublicKey(fs.readFileSync(publicPath)).asymmetricKeyDetails?.modulusLength, 4096);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(privatePath)).digest('hex');
    const again = run('sh', ['scripts/create-worker-signing-key.sh', keyDir]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /never overwrite/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(privatePath)).digest('hex'), hash);
    assert.doesNotMatch(first.stdout, /BEGIN .*PRIVATE KEY/);
  } finally {
    fs.rmSync(keyDir, { recursive: true, force: true });
  }
});
