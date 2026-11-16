import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

void test('Quick Setup signed-distribution mount preflight fails closed without Docker side effects', () => {
  if (process.platform !== 'linux') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-signed-dist-'));
  const dist = path.join(root, 'signed-dist');
  const bin = path.join(root, 'fake-bin');
  const script = path.resolve(process.cwd(), 'quick-setup.sh');
  const binaries = [
    'worker_mcp-darwin-amd64',
    'worker_mcp-darwin-arm64',
    'worker_mcp-linux-386',
    'worker_mcp-linux-amd64',
    'worker_mcp-linux-arm64',
    'worker_mcp-linux-armv7',
    'worker_mcp-windows-amd64.exe',
    'worker_mcp-windows-arm64.exe',
  ];
  const run = (signedDir: string) =>
    spawnSync('sh', [script, '--start'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        MCP_WORKER_SIGNED_DIST_DIR: signedDir,
        MCP_WORKER_CONTAINER: 'signed-preflight-test',
        MCP_WORKER_VOLUME: 'signed-preflight-volume',
        MCP_WORKER_SETUP_PORT: '3398',
      },
    });
  try {
    fs.mkdirSync(bin);
    fs.mkdirSync(dist, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\n[ "$1" = info ] && exit 0\nexit 99\n', {
      mode: 0o755,
    });
    for (const name of binaries) {
      fs.writeFileSync(path.join(dist, name), 'test-only binary placeholder\n', { mode: 0o644 });
    }
    fs.writeFileSync(
      path.join(dist, 'WORKER_RELEASE'),
      'version=0.0.0\ncommit=0000000000000000000000000000000000000000\n',
      { mode: 0o644 },
    );
    const checksums =
      [...binaries, 'WORKER_RELEASE']
        .map((name) => {
          const digest = crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(dist, name)))
            .digest('hex');
          return digest + '  ' + name;
        })
        .join('\n') + '\n';
    fs.writeFileSync(path.join(dist, 'SHA256SUMS'), checksums, { mode: 0o644 });
    fs.writeFileSync(path.join(dist, 'SHA256SUMS.sig'), 'fixture-not-valid-signature', {
      mode: 0o644,
    });

    assert.match(run('relative/path').stderr, /absolute path/);
    fs.rmSync(path.join(dist, 'SHA256SUMS.sig'));
    assert.match(run(dist).stderr, /missing, empty or symlinked: SHA256SUMS.sig/);
    fs.symlinkSync('WORKER_RELEASE', path.join(dist, 'SHA256SUMS.sig'));
    assert.match(run(dist).stderr, /missing, empty or symlinked: SHA256SUMS.sig/);
    fs.rmSync(path.join(dist, 'SHA256SUMS.sig'));
    fs.writeFileSync(path.join(dist, 'SHA256SUMS.sig'), 'fixture-not-valid-signature', {
      mode: 0o644,
    });

    fs.appendFileSync(path.join(dist, 'WORKER_RELEASE'), 'tampered\n');
    assert.match(run(dist).stderr, /checksum inventory mismatch/);
    fs.writeFileSync(
      path.join(dist, 'WORKER_RELEASE'),
      'version=0.0.0\ncommit=0000000000000000000000000000000000000000\n',
    );
    fs.chmodSync(path.join(dist, 'WORKER_RELEASE'), 0o600);
    assert.match(run(dist).stderr, /unreadable by the non-root server/);
    fs.chmodSync(path.join(dist, 'WORKER_RELEASE'), 0o644);

    const accepted = run(dist);
    assert.notEqual(accepted.status, 0, 'existing database setup must still be required');
    assert.match(accepted.stderr, /No installation found/);
    assert.doesNotMatch(accepted.stderr, /Signed distribution/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
