import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import workerRoutes = require('../src/routes/workerRoutes');

const VERSION_A = '2.3.4';
const COMMIT_A = '0123456789ab';
const VERSION_B = '2.3.5';
const COMMIT_B = '112233445566';

function hash(data: Buffer | string) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function signer() {
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: keys.privateKey,
    publicPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicKeyBase64: Buffer.from(
      keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ).toString('base64'),
  };
}
type Package = { binary: Buffer; metadata: Buffer; sums: Buffer; signature: Buffer };
function bundle(
  key: ReturnType<typeof signer>,
  file: string,
  binary: Buffer,
  version: string,
  commit: string,
): Package {
  const metadata = Buffer.from('version=' + version + '\ncommit=' + commit + '\n');
  const sums = Buffer.from(
    hash(binary) + '  ' + file + '\n' + hash(metadata) + '  WORKER_RELEASE\n',
  );
  return {
    binary,
    metadata,
    sums,
    signature: crypto.sign('sha256', sums, key.privateKey),
  };
}
function execute(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    output: String(result.stdout || '') + String(result.stderr || ''),
  };
}

void test('no approved release is embedded in any downloadable installer', () => {
  for (const source of [
    workerRoutes.installerScript('https://example.test'),
    workerRoutes.macInstallerScript('https://example.test'),
    workerRoutes.windowsInstallerScript('https://example.test'),
    workerRoutes.windowsInstallerPayloadScript('https://example.test'),
  ]) {
    assert.match(source, /[Ss]igned release not approved/);
    assert.doesNotMatch(source, /openssl dgst -sha256 -verify \$env:BOT_REPORT_WORKER_TRUSTED_KEY/);
  }
  assert.equal(
    workerRoutes.windowsInstallerScript('https://example.test'),
    workerRoutes.windowsInstallerPayloadScript('https://example.test'),
    'PowerShell must not fetch/execute an unsigned second-stage script',
  );
});

void test('offline native installer rejects fake, unsigned, wrong-key, wrong-version and rollback', {
  timeout: 180000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-signed-release-'));
  const key = signer();
  const wrong = signer();
  const win = process.platform === 'win32';
  const unix = process.platform === 'linux' || process.platform === 'darwin';
  if (!win && !unix) {
    fs.rmSync(root, { recursive: true, force: true });
    t.skip('no native installer target on this OS');
    return;
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const file = 'bot-report-worker-' +
    (win ? 'windows-' + arch + '.exe' : process.platform + '-' + arch);
  const installed = path.join(root, 'install', 'current', win ? 'bot-report-worker.exe' : 'systemtd');
  const stateRoot = path.join(root, 'state');
  const tempHome = path.join(root, 'home');
  fs.mkdirSync(tempHome);
  const fixture = path.join(root, win ? 'fixture.exe' : 'fixture.sh');
  if (win) {
    const stub = path.join(root, 'fixture.go');
    fs.writeFileSync(stub, [
      'package main',
      'import "os"',
      'func main() {',
      ' if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "stop") { return }',
      ' os.Exit(0)',
      '}',
      '',
    ].join('\n'));
    const built = execute('go', ['build', '-o', fixture, stub], process.env, root);
    assert.equal(built.code, 0, built.output);
  } else {
    fs.writeFileSync(fixture,
      '#!/bin/sh\ncase "$1" in version|stop|uninstall) exit 0;; status) echo "status: STOPPED"; exit 0;; *) exit 0;; esac\n',
      { mode: 0o755 });
  }
  const binaryA = fs.readFileSync(fixture);
  const binaryB = Buffer.concat([binaryA, Buffer.from('\nSIGNED_TEST_ONLY_VARIANT_B\n')]);
  const packageA = bundle(key, file, binaryA, VERSION_A, COMMIT_A);
  const packageB = bundle(key, file, binaryB, VERSION_B, COMMIT_B);
  let active: Package = packageA;
  let missingSignature = false;
  let server: http.Server | undefined;
  try {
    server = http.createServer((req, res) => {
      const value = req.url === '/worker/dist/' + file ? active.binary
        : req.url === '/worker/dist/WORKER_RELEASE' ? active.metadata
          : req.url === '/worker/dist/SHA256SUMS' ? active.sums
            : req.url === '/worker/dist/SHA256SUMS.sig' && !missingSignature
              ? active.signature : null;
      if (!value) { res.writeHead(404); res.end('missing'); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(value);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const base = 'http://127.0.0.1:' + addr.port;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tempHome,
      BOT_REPORT_WORKER_HOME: stateRoot,
      BOT_REPORT_WORKER_INSTALL_ROOT: path.join(root, 'install'),
      BOT_REPORT_WORKER_BIN_DIR: path.join(root, 'bin'),
      BOT_REPORT_WORKER_SYSTEMD: '0',
      BOT_REPORT_WORKER_SKIP_SERVICE: '1',
      BOT_REPORT_WORKER_SKIP_PATH: '1',
    };
    function install(
      approval = { version: VERSION_A, commit: COMMIT_A, publicKeyBase64: key.publicKeyBase64 },
      extra: NodeJS.ProcessEnv = {},
    ) {
      const script = win
        ? workerRoutes.windowsInstallerScript(base, approval)
        : process.platform === 'darwin'
          ? workerRoutes.macInstallerScript(base, approval)
          : workerRoutes.installerScript(base, approval);
      const scriptFile = path.join(root, win ? 'install.ps1' : 'install.sh');
      fs.writeFileSync(scriptFile, script);
      return execute(win ? 'pwsh' : 'sh',
        win ? ['-NoProfile', '-NonInteractive', '-File', scriptFile] : [scriptFile],
        { ...env, ...extra }, root);
    }
    function unchanged(label: string, result: ReturnType<typeof execute>, expected = binaryA) {
      assert.notEqual(result.code, 0, label + ': unexpectedly succeeded');
      assert.deepEqual(fs.readFileSync(installed), expected, label + ': replaced runtime');
    }
    const first = install();
    assert.equal(first.code, 0, 'signed fresh install: ' + first.output);
    assert.deepEqual(fs.readFileSync(installed), binaryA);
    assert.equal(fs.readFileSync(path.join(stateRoot, 'release-version'), 'utf8').trim(), VERSION_A);
    assert.equal(fs.readFileSync(path.join(stateRoot, 'release-commit'), 'utf8').trim(), COMMIT_A);
    await t.test('valid signed same-version reinstall', () => {
      assert.equal(install().code, 0);
    });
    await t.test('modified binary', () => {
      active = { ...packageA, binary: Buffer.concat([binaryA, Buffer.from('tamper')]) };
      unchanged('modified binary', install());
      active = packageA;
    });
    await t.test('tampered SHA256SUMS', () => {
      active = { ...packageA, sums: Buffer.from(packageA.sums.toString().replace(hash(binaryA), '0'.repeat(64))) };
      unchanged('tampered manifest', install());
      active = packageA;
    });
    await t.test('missing signature', () => {
      missingSignature = true;
      unchanged('missing signature', install());
      missingSignature = false;
    });
    await t.test('wrong signature', () => {
      const sig = Buffer.from(packageA.signature);
      sig[0] ^= 1;
      active = { ...packageA, signature: sig };
      unchanged('wrong signature', install());
      active = packageA;
    });
    await t.test('public verification key mismatch', () => {
      unchanged('wrong public key', install({
        version: VERSION_A, commit: COMMIT_A, publicKeyBase64: wrong.publicKeyBase64,
      }));
    });
    await t.test('modified signed metadata bytes', () => {
      active = { ...packageA, metadata: Buffer.from('version=0.0.0\ncommit=' + COMMIT_A + '\n') };
      unchanged('metadata tamper', install());
      active = packageA;
    });
    await t.test('valid signature but mismatched release version', () => {
      active = bundle(key, file, binaryA, VERSION_B, COMMIT_B);
      unchanged('mismatched pin', install());
      active = packageA;
    });
    await t.test('manual rollback rejected', () => {
      unchanged('manual rollback', install(undefined, { BOT_REPORT_WORKER_ACTION: 'rollback' }));
    });
    await t.test('valid signed version upgrade', () => {
      active = packageB;
      const upgraded = install({ version: VERSION_B, commit: COMMIT_B, publicKeyBase64: key.publicKeyBase64 });
      assert.equal(upgraded.code, 0, 'signed upgrade: ' + upgraded.output);
      assert.deepEqual(fs.readFileSync(installed), binaryB);
      assert.equal(fs.readFileSync(path.join(stateRoot, 'release-version'), 'utf8').trim(), VERSION_B);
    });
    await t.test('previously valid signed release cannot downgrade', () => {
      active = packageA;
      unchanged('signed downgrade', install(), binaryB);
    });
    await t.test('same version with different signed commit is rejected', () => {
      active = bundle(key, file, binaryB, VERSION_B, 'bbbbbbbbbbbb');
      unchanged('version reuse', install({
        version: VERSION_B, commit: 'bbbbbbbbbbbb', publicKeyBase64: key.publicKeyBase64,
      }), binaryB);
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test('signer requires approved version, canonical checksums and RSA private key', {
  skip: process.platform !== 'linux' ? 'canonical SHA256SUMS signer runs on Linux' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-manifest-sign-'));
  try {
    const scripts = path.join(root, 'scripts');
    const bin = path.join(root, 'worker', 'bin');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(scripts, 'sign-worker-manifest.sh');
    fs.copyFileSync(path.join(__dirname, '../scripts/sign-worker-manifest.sh'), script);
    const names = [
      'bot-report-worker-darwin-amd64', 'bot-report-worker-darwin-arm64',
      'bot-report-worker-linux-386', 'bot-report-worker-linux-amd64',
      'bot-report-worker-linux-arm64', 'bot-report-worker-linux-armv7',
      'bot-report-worker-windows-amd64.exe', 'bot-report-worker-windows-arm64.exe',
      'WORKER_RELEASE',
    ];
    for (const name of names) {
      fs.writeFileSync(path.join(bin, name),
        name === 'WORKER_RELEASE' ? 'version=' + VERSION_A + '\ncommit=' + COMMIT_A + '\n' : name);
    }
    function sums() {
      return names.map(name => hash(fs.readFileSync(path.join(bin, name))) + '  ' + name + '\n').join('');
    }
    fs.writeFileSync(path.join(bin, 'SHA256SUMS'), sums());
    const key = signer();
    const privatePath = path.join(root, 'ephemeral-private.pem');
    fs.writeFileSync(privatePath, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    function sign(expectedVersion: string) {
      return execute('sh', [script, privatePath], {
        ...process.env,
        WORKER_RELEASE_EXPECTED_VERSION: expectedVersion,
        WORKER_RELEASE_EXPECTED_COMMIT: COMMIT_A,
      }, root);
    }
    assert.notEqual(sign(VERSION_B).code, 0, 'wrong approval version accepted');
    fs.writeFileSync(path.join(bin, 'SHA256SUMS'), sums().replace(hash('WORKER_RELEASE'), '0'.repeat(64)));
    assert.notEqual(sign(VERSION_A).code, 0, 'tampered checksum accepted');
    fs.writeFileSync(path.join(bin, 'SHA256SUMS'), sums());
    assert.equal(sign(VERSION_A).code, 0, 'signed candidate failed');
    const manifest = fs.readFileSync(path.join(bin, 'SHA256SUMS'));
    const signature = fs.readFileSync(path.join(bin, 'SHA256SUMS.sig'));
    assert.equal(crypto.verify('sha256', manifest, key.publicPem, signature), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
