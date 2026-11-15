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

// Reuse the production installer generator, but inject only ephemeral test trust.
// This does not change or approve the fail-closed release distribution routes.
const { installerScript } = require('../dist/src/routes/workerRoutes');

async function execute(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs || 60000);
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
  if (process.env.BOT_REPORT_LIFECYCLE_TEST_ORIGIN)
    throw new Error('External staging origin is no longer used; this fixture serves its own test-only loopback release');

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

    // Produce two real, identity-distinct, native Go Worker binaries with no
    // network access or signing material outside this disposable test root.
    const commits = {
      A: '0123456789abcdef0123456789abcdef01234567',
      B: '1122334455667788990011223344556677889900',
    };
    const versions = { A: '2.3.4', B: '2.3.5' };
    const binaries = {};
    const goBin = process.env.GO_BIN || 'go';
    const goVersion = await execute(goBin, ['version'], { timeoutMs: 15000 });
    assert.equal(goVersion.code, 0, 'offline Go toolchain is required');
    assert.match(goVersion.out, /go1[.]24[.]/, 'test-only signed fixture requires Go 1.24');
    for (const variantName of ['A', 'B']) {
      const output = path.join(testRoot, 'fixture-worker-' + variantName);
      const build = await execute(goBin, [
        'build', '-buildvcs=false', '-trimpath',
        '-ldflags', '-s -w -X main.version=' + versions[variantName] +
          ' -X main.commit=' + commits[variantName],
        '-o', output, '.',
      ], {
        cwd: path.resolve(__dirname, '../worker-go'),
        env: { ...process.env, GOTOOLCHAIN: 'local', GOPROXY: 'off', CGO_ENABLED: '0' },
        timeoutMs: 120000,
      });
      assert.equal(build.code, 0, 'offline test-only Go ' + variantName + ': ' + build.err.slice(0, 1000));
      binaries[variantName] = fs.readFileSync(output);
      assert.ok(binaries[variantName].length > 100000, 'unexpected native Worker binary size');
    }
    const binaryA = binaries.A;
    const binaryB = binaries.B;
    assert.notEqual(fingerprint(binaryA), fingerprint(binaryB), 'upgrade fixture must actually differ');

    // Generate test-only SPKI, sign the canonical nine-entry manifest, and pin
    // its independent SHA-256 DER fingerprint in the generated shell installer.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyBase64 = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
    const publicKeySha256 = fingerprint(publicKey.export({ type: 'spki', format: 'der' }));
    const files = [
      'bot-report-worker-darwin-amd64',
      'bot-report-worker-darwin-arm64',
      'bot-report-worker-linux-386',
      'bot-report-worker-linux-amd64',
      'bot-report-worker-linux-arm64',
      'bot-report-worker-linux-armv7',
      'bot-report-worker-windows-amd64.exe',
      'bot-report-worker-windows-arm64.exe',
      'WORKER_RELEASE',
    ];
    let variant = 'A';
    let badChecksum = false;
    let badSignature = false;
    let missingSignature = false;
    let tamperedManifest = false;
    let releaseVersionOverride = '';
    function releaseVersion() { return versions[variant]; }
    function releaseCommit() { return commits[variant]; }
    function metadata() {
      return 'version=' + (releaseVersionOverride || releaseVersion()) +
        '\ncommit=' + releaseCommit() + '\n';
    }
    function manifest() {
      const binary = binaries[variant];
      return files.map(file => {
        const data = file === 'WORKER_RELEASE' ? metadata()
          : file === 'bot-report-worker-linux-amd64' ? binary
          : 'test-only-placeholder:' + file;
        const checksum = badChecksum && file === 'bot-report-worker-linux-amd64'
          ? '0'.repeat(64) : fingerprint(data);
        return checksum + '  ' + file + '\n';
      }).join('');
    }
    assert.equal(manifest().trimEnd().split('\n').length, 9);
    server = http.createServer((req, res) => {
      const file = binaries[variant];
      if (req.url === '/worker/dist/bot-report-worker-linux-amd64') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(file);
      } else if (req.url === '/worker/dist/SHA256SUMS') {
        const sums = manifest();
        const corrupted = sums[0] === 'f' ? 'e' : 'f';
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(tamperedManifest ? corrupted + sums.slice(1) : sums);
      } else if (req.url === '/worker/dist/WORKER_RELEASE') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(metadata());
      } else if (req.url === '/worker/dist/SHA256SUMS.sig' && !missingSignature) {
        const signature = crypto.sign('sha256', Buffer.from(manifest()), privateKey);
        if (badSignature) signature[0] ^= 0xff;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(signature);
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
    function writeApprovedInstaller(keyBase64 = publicKeyBase64, keySha256 = publicKeySha256) {
      const rendered = installerScript(localOrigin, {
        version: releaseVersion(),
        commit: releaseCommit(),
        publicKeyBase64: keyBase64,
        publicKeySha256: keySha256,
      });
      assert.match(rendered, /^PINNED_COMMIT='[0-9a-f]{40}'$/m);
      assert.ok(rendered.includes("PINNED_PUBLIC_KEY_SHA256='" + keySha256 + "'"));
      fs.writeFileSync(installer, rendered, { mode: 0o644 });
      fs.chmodSync(installer, 0o644); // umask 077 in PC runner must not hide script from test UID
    }
    writeApprovedInstaller();

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

    requireSuccess(await run(['sh', installer]), 'signed user-mode fresh install');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    assert.equal(fs.readlinkSync(path.join(bin, 'systemtd')), current);
    assert.equal(fs.readlinkSync(path.join(bin, 'bot-report-worker')), current);
    const identityMarker = fs.readFileSync(path.join(state, 'install-root'), 'utf8');
    assert.equal(identityMarker.trim(), install);
    requireSuccess(await run([current, 'version']), 'installed native Go binary executes');

    requireSuccess(await run(['sh', installer]), 'same-build reinstall is no-op');
    assert.ok(!fs.existsSync(previous), 'Identical install created unexpected rollback build');

    variant = 'B';
    writeApprovedInstaller();
    badSignature = true;
    const tamperedSignature = await run(['sh', installer]);
    assert.notEqual(tamperedSignature.code, 0, 'Invalid signing signature was accepted');
    assert.match(tamperedSignature.err + tamperedSignature.out, /signature|verification/i);
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    console.log('PASS invalid signed manifest rejected before replacement');

    badSignature = false;
    missingSignature = true;
    const unsigned = await run(['sh', installer]);
    assert.notEqual(unsigned.code, 0, 'Missing signature was accepted with trust key configured');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    console.log('PASS missing signed manifest rejected before replacement');

    missingSignature = false;
    tamperedManifest = true;
    const brokenManifest = await run(['sh', installer]);
    assert.notEqual(brokenManifest.code, 0, 'Modified SHA256SUMS was accepted');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    tamperedManifest = false;
    console.log('PASS altered SHA256SUMS rejected');

    const mismatchedKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    writeApprovedInstaller(
      Buffer.from(mismatchedKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
      fingerprint(mismatchedKey.export({ type: 'spki', format: 'der' })),
    );
    const wrongKey = await run(['sh', installer]);
    assert.notEqual(wrongKey.code, 0, 'Mismatched public key accepted');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    writeApprovedInstaller();
    console.log('PASS wrong pinned public key rejected');

    writeApprovedInstaller(publicKeyBase64, '0'.repeat(64));
    const badSpki = await run(['sh', installer]);
    assert.notEqual(badSpki.code, 0, 'Bad pinned SPKI fingerprint accepted');
    assert.match(badSpki.err + badSpki.out, /fingerprint/i);
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    writeApprovedInstaller();
    console.log('PASS mismatched pinned SPKI digest rejected');

    releaseVersionOverride = '9.9.9';
    const mismatchedVersion = await run(['sh', installer]);
    assert.notEqual(mismatchedVersion.code, 0, 'Signed version mismatch was accepted');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryA));
    releaseVersionOverride = '';
    console.log('PASS signed metadata release version mismatch rejected');

    badChecksum = true;
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

    const unauthorizedRollback = await run(['sh', installer], { BOT_REPORT_WORKER_ACTION: 'rollback' });
    assert.notEqual(unauthorizedRollback.code, 0, 'Unsigned manual rollback accepted');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryB));
    console.log('PASS unauthorized manual rollback rejected');

    variant = 'A';
    writeApprovedInstaller();
    const staleSignedRelease = await run(['sh', installer]);
    assert.notEqual(staleSignedRelease.code, 0, 'Older signed release was accepted');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryB));
    variant = 'B';
    writeApprovedInstaller();
    console.log('PASS older signed release rejected');

    // Verify the privileged service mode cannot be modified by a manual
    // user-mode installer or uninstalled through the native CLI.
    const serviceMode = path.join(state, 'service-mode');
    fs.writeFileSync(serviceMode, 'systemd\n', { mode: 0o600 });
    if (process.getuid() === 0) fs.chownSync(serviceMode, uid, gid);
    const unsafeManualUpdate = await run(['sh', installer]);
    assert.notEqual(unsafeManualUpdate.code, 0, 'Manual installer changed a systemd-managed runtime');
    assert.match(unsafeManualUpdate.err + unsafeManualUpdate.out, /managed service detected/i);
    const unsafeManagedUninstall = await run([current, 'uninstall']);
    assert.notEqual(unsafeManagedUninstall.code, 0, 'Native uninstall removed a managed service');
    assert.equal(fingerprint(fs.readFileSync(current)), fingerprint(binaryB));
    fs.unlinkSync(serviceMode);
    console.log('PASS systemd-managed identity rejects manual update and uninstall');

    requireSuccess(await run([current, 'uninstall']), 'native worker uninstall');
    assert.ok(!fs.existsSync(install), 'Installer-managed binaries not removed');
    assert.ok(!fs.existsSync(state), 'Worker state not removed');
    assert.ok(!fs.existsSync(path.join(bin, 'systemtd')), 'CLI symlink not removed');
    assert.ok(!fs.existsSync(path.join(bin, 'bot-report-worker')), 'Legacy CLI symlink not removed');
    console.log('PASS native Linux test-only signed lifecycle with nine-entry manifest; no production signer or server used');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error('FAIL Linux installer lifecycle:', error.message); process.exitCode = 1; });
