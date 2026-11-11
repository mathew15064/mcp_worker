#!/usr/bin/env node
'use strict';

// Native Linux manual Worker installer lifecycle smoke; no enrollment or service.
// The source server MUST be a trusted loopback-only local staging installation.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function execute(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', chunk => { out += chunk.toString(); });
    child.stderr.on('data', chunk => { err += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

function fingerprint(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Only supported on native Linux x64');
  const origin = new URL(process.env.BOT_REPORT_LIFECYCLE_TEST_ORIGIN || 'http://127.0.0.1:13337');
  if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:' ||
      origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('Refusing non-loopback or unexpected source origin');

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts63-linux-worker-lifecycle-'));
  const uid = process.getuid() === 0 ? 65534 : process.getuid();
  const gid = process.getuid() === 0 ? 65534 : process.getgid();
  let server;
  try {
    // This is an isolated, unprivileged test account, with no systemd/sudo.
    if (process.getuid() === 0) fs.chownSync(testRoot, uid, gid);
    const home = path.join(testRoot, 'home');
    const state = path.join(testRoot, 'state');
    const install = path.join(testRoot, 'install');
    const bin = path.join(testRoot, 'bin');
    fs.mkdirSync(home, { recursive: true });
    if (process.getuid() === 0) fs.chownSync(home, uid, gid);

    const [installerResponse, binaryResponse] = await Promise.all([
      fetch(new URL('/worker/install-linux.sh', origin)),
      fetch(new URL('/worker/dist/bot-report-worker-linux-amd64', origin)),
    ]);
    assert.equal(installerResponse.status, 200, 'installer source not available');
    assert.equal(binaryResponse.status, 200, 'worker binary not available');
    const template = await installerResponse.text();
    const binaryA = Buffer.from(await binaryResponse.arrayBuffer());
    assert.match(template, /^BASE_URL='http:\/\/127\.0\.0\.1:[0-9]+'$/m);
    assert.ok(binaryA.length > 100000, 'Unexpected worker binary size');
    // Trailing ELF padding produces a *different*, still-executable test-only
    // build without contacting a real release repository or changing binaries.
    const binaryB = Buffer.concat([binaryA, Buffer.from('\nTS63_FIXTURE_ONLY_DISTINCT_ELF\n')]);
    assert.notEqual(fingerprint(binaryA), fingerprint(binaryB));

    let variant = 'A';
    let badChecksum = false;
    server = http.createServer((req, res) => {
      const file = variant === 'A' ? binaryA : binaryB;
      if (req.url === '/worker/dist/bot-report-worker-linux-amd64') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(file);
      } else if (req.url === '/worker/dist/SHA256SUMS') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end((badChecksum ? '0'.repeat(64) : fingerprint(file)) +
          '  bot-report-worker-linux-amd64\n');
      } else {
        res.writeHead(404); res.end('not found');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const localOrigin = 'http://127.0.0.1:' + server.address().port;
    const installer = path.join(testRoot, 'install-linux.sh');
    const patched = template.replace(/^BASE_URL='[^']+'$/m, "BASE_URL='" + localOrigin + "'");
    assert.ok(patched.includes("BASE_URL='" + localOrigin + "'"));
    fs.writeFileSync(installer, patched, { mode: 0o644 });

    const env = {
      HOME: home,
      PATH: process.env.PATH || '/usr/bin:/bin',
      BOT_REPORT_WORKER_HOME: state,
      BOT_REPORT_WORKER_INSTALL_ROOT: install,
      BOT_REPORT_WORKER_BIN_DIR: bin,
      BOT_REPORT_WORKER_SYSTEMD: '0',
      BOT_REPORT_WORKER_SKIP_SERVICE: '1',
    };
    const opts = { env, cwd: testRoot, uid, gid };
    const current = path.join(install, 'current', 'systemtd');
    const previous = path.join(install, 'previous', 'systemtd');
    async function run(args, extraEnv) {
      const result = await execute(args[0], args.slice(1), { ...opts, env: { ...env, ...extraEnv } });
      return result;
    }
    function requireSuccess(result, label) {
      assert.equal(result.code, 0, label + ': ' + result.err.slice(0, 1200));
      console.log('PASS ' + label);
    }

    requireSuccess(await run(['sh', installer]), 'fresh user-mode install');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    assert.equal(fs.readlinkSync(path.join(bin, 'systemtd')), current);
    assert.equal(fs.readlinkSync(path.join(bin, 'bot-report-worker')), current);
    const identityMarker = fs.readFileSync(path.join(state, 'install-root'), 'utf8');
    assert.equal(identityMarker.trim(), install);
    requireSuccess(await run([current, 'version']), 'installed native Go binary executes');

    requireSuccess(await run(['sh', installer]), 'same-build reinstall is no-op');
    assert.ok(!fs.existsSync(previous), 'Identical install created unexpected rollback build');

    variant = 'B'; badChecksum = true;
    const rejected = await run(['sh', installer]);
    assert.notEqual(rejected.code, 0, 'Tampered checksum was accepted');
    assert.match(rejected.err + rejected.out, /checksum verification failed/i);
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    console.log('PASS corrupted binary/manifest rejects before replacement');

    badChecksum = false;
    requireSuccess(await run(['sh', installer]), 'distinct-binary upgrade');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryB));
    assert.equal(fingerprint(fs.readFileSync(previous)), fingerprint(binaryA));
    assert.equal(fs.readFileSync(path.join(state, 'install-root'), 'utf8'), identityMarker);

    requireSuccess(await run(['sh', installer], { BOT_REPORT_WORKER_ACTION: 'rollback' }),
      'checksum-verified manual rollback');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    assert.equal(fingerprint(fs.readFileSync(previous)), fingerprint(binaryB));

    requireSuccess(await run([current, 'uninstall']), 'native worker uninstall');
    assert.ok(!fs.existsSync(install), 'Installer-managed binaries not removed');
    assert.ok(!fs.existsSync(state), 'Worker state not removed');
    assert.ok(!fs.existsSync(path.join(bin, 'systemtd')), 'CLI symlink not removed');
    assert.ok(!fs.existsSync(path.join(bin, 'bot-report-worker')), 'Legacy CLI symlink not removed');
    console.log('PASS test data isolated to ' + path.basename(testRoot) + ' and cleaned up');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error('FAIL Linux installer lifecycle:', error.message); process.exitCode = 1; });
