import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

type ApprovedRelease = {
  version: string;
  commit: string;
  publicKeyBase64: string;
  previousPublicKeySha256?: string;
};
type Installer = (baseUrl: string, approval?: ApprovedRelease) => string;
type WorkerRouteApi = {
  installerScript: Installer;
  macInstallerScript: Installer;
  windowsInstallerScript: Installer;
  windowsInstallerPayloadScript: Installer;
};
const workerRoutes = createRequire(__filename)('../src/routes/workerRoutes') as WorkerRouteApi;

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
    fingerprint: hash(keys.publicKey.export({ type: 'spki', format: 'der' })),
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
function execute(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
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

void test('installer protocols refuse public plaintext and redirect downgrade', () => {
  for (const script of [
    workerRoutes.installerScript('https://worker.example.test'),
    workerRoutes.macInstallerScript('https://worker.example.test'),
  ]) {
    assert.match(script, /HTTPS release origin required/);
    assert.match(script, /--proto "=\$DOWNLOAD_SCHEME"/);
    assert.match(script, /--proto-redir "=\$DOWNLOAD_SCHEME"/);
  }
  const windows = workerRoutes.windowsInstallerPayloadScript('https://worker.example.test');
  assert.match(windows, /HTTPS release origin required/);
  assert.equal((windows.match(/-MaximumRedirection 0/g) ?? []).length, 4);
});

void test('Railway installer and binary distribution stay HTTP 503 without approval', async () => {
  const previousPlatform = process.env.MCP_PLATFORM;
  const previousApproval = process.env.WORKER_SIGNED_RELEASE_APPROVED;
  const previousKey = process.env.WORKER_TRUSTED_PUBLIC_KEY;
  process.env.MCP_PLATFORM = 'railway';
  // Runtime variables must never turn a source-unapproved release into a
  // distributable Worker, even with a purported signing key present.
  process.env.WORKER_SIGNED_RELEASE_APPROVED = 'true';
  process.env.WORKER_TRUSTED_PUBLIC_KEY = 'unreviewed-key';
  const app = express();
  app.use(workerRoutes as unknown as express.Router);
  const server = http.createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const endpoint of [
      '/worker/install.sh',
      '/worker/install-linux.sh',
      '/worker/install-macos.sh',
      '/worker/install.ps1',
      '/worker/install-windows.ps1',
      '/worker/dist/SHA256SUMS',
      '/worker/dist/SHA256SUMS.sig',
      '/worker/dist/WORKER_RELEASE',
      '/worker/dist/bot-report-worker-linux-amd64',
      '/worker/dist/cli.js',
    ]) {
      const response: Response = await fetch('http://127.0.0.1:' + address.port + endpoint);
      assert.equal(response.status, 503, endpoint);
      assert.equal(response.headers.get('cache-control'), 'no-store', endpoint);
      const body = (await response.json()) as { code: string };
      assert.equal(body.code, 'WORKER_SIGNED_RELEASE_PENDING', endpoint);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousPlatform === undefined) delete process.env.MCP_PLATFORM;
    else process.env.MCP_PLATFORM = previousPlatform;
    if (previousApproval === undefined) delete process.env.WORKER_SIGNED_RELEASE_APPROVED;
    else process.env.WORKER_SIGNED_RELEASE_APPROVED = previousApproval;
    if (previousKey === undefined) delete process.env.WORKER_TRUSTED_PUBLIC_KEY;
    else process.env.WORKER_TRUSTED_PUBLIC_KEY = previousKey;
  }
});

void test(
  'offline native installer rejects fake, unsigned, wrong-key, wrong-version and rollback',
  {
    timeout: 180000,
  },
  async (t) => {
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
    const file =
      'bot-report-worker-' + (win ? 'windows-' + arch + '.exe' : process.platform + '-' + arch);
    const installed = path.join(
      root,
      'install',
      'current',
      win ? 'bot-report-worker.exe' : 'systemtd',
    );
    const stateRoot = path.join(root, 'state');
    const tempHome = path.join(root, 'home');
    fs.mkdirSync(tempHome);
    const fixture = path.join(root, win ? 'fixture.exe' : 'fixture.sh');
    const stub = path.join(root, 'fixture.go');
    if (win) {
      fs.writeFileSync(
        stub,
        [
          'package main',
          'import ("fmt"; "os")',
          'var version = "unset"',
          'var commit = "unset"',
          'func main() {',
          ' if len(os.Args) < 2 { return }',
          ' switch os.Args[1] {',
          ' case "version": fmt.Printf("systemtd %s commit=%s runtime=stub windows/amd64\\n", version, commit)',
          ' case "status": if os.Getenv("SIGNED_TEST_RUNNING") == "1" { fmt.Println("status: RUNNING") } else { fmt.Println("status: STOPPED") }',
          ' case "start": if os.Getenv("SIGNED_TEST_FAIL_START") == "1" { os.Exit(1) }',
          ' }',
          '}',
          '',
        ].join('\n'),
      );
    }
    async function makeBinary(version: string, commit: string) {
      if (win) {
        const built = await execute(
          'go',
          [
            'build',
            '-ldflags',
            '-X main.version=' + version + ' -X main.commit=' + commit,
            '-o',
            fixture,
            stub,
          ],
          process.env,
          root,
        );
        assert.equal(built.code, 0, built.output);
        return fs.readFileSync(fixture);
      }
      return Buffer.from(
        [
          '#!/bin/sh',
          'case "$1" in',
          ' version) printf "systemtd ' +
            version +
            ' commit=' +
            commit +
            ' runtime=stub ' +
            process.platform +
            '/' +
            arch +
            '\\n";;',
          ' stop|uninstall) exit 0;;',
          ' status) if [ "${SIGNED_TEST_RUNNING:-0}" = 1 ]; then echo "status: RUNNING"; else echo "status: STOPPED"; fi;;',
          ' start) [ "${SIGNED_TEST_FAIL_START:-0}" != 1 ];;',
          ' *) exit 0;;',
          'esac',
          '',
        ].join('\n'),
      );
    }
    const binaryA = await makeBinary(VERSION_A, COMMIT_A);
    const binaryB = await makeBinary(VERSION_B, COMMIT_B);
    const binaryWrongCommit = await makeBinary(VERSION_B, COMMIT_A);
    const binaryC = await makeBinary('2.3.7', 'aabbccddeeff');
    const binaryD = await makeBinary('2.3.6', 'aabbccddeeff');
    const packageA = bundle(key, file, binaryA, VERSION_A, COMMIT_A);
    const packageB = bundle(key, file, binaryB, VERSION_B, COMMIT_B);
    let active: Package = packageA;
    let missingSignature = false;
    let server: http.Server | undefined;
    try {
      server = http.createServer((req, res) => {
        const value =
          req.url === '/worker/dist/' + file
            ? active.binary
            : req.url === '/worker/dist/WORKER_RELEASE'
              ? active.metadata
              : req.url === '/worker/dist/SHA256SUMS'
                ? active.sums
                : req.url === '/worker/dist/SHA256SUMS.sig' && !missingSignature
                  ? active.signature
                  : null;
        if (!value) {
          res.writeHead(404);
          res.end('missing');
          return;
        }
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
      async function install(
        approval: ApprovedRelease = {
          version: VERSION_A,
          commit: COMMIT_A,
          publicKeyBase64: key.publicKeyBase64,
        },
        extra: NodeJS.ProcessEnv = {},
      ) {
        const script = win
          ? workerRoutes.windowsInstallerScript(base, approval)
          : process.platform === 'darwin'
            ? workerRoutes.macInstallerScript(base, approval)
            : workerRoutes.installerScript(base, approval);
        const scriptFile = path.join(root, win ? 'install.ps1' : 'install.sh');
        fs.writeFileSync(scriptFile, script);
        return execute(
          win ? 'pwsh' : 'sh',
          win ? ['-NoProfile', '-NonInteractive', '-File', scriptFile] : [scriptFile],
          { ...env, ...extra },
          root,
        );
      }
      async function unchanged(
        label: string,
        result: ReturnType<typeof execute>,
        expected = binaryA,
      ) {
        const outcome = await result;
        assert.notEqual(outcome.code, 0, label + ': unexpectedly succeeded');
        assert.deepEqual(fs.readFileSync(installed), expected, label + ': replaced runtime');
        const expectedVersion = expected.equals(binaryA)
          ? VERSION_A
          : expected.equals(binaryB)
            ? VERSION_B
            : '2.3.7';
        const expectedCommit = expected.equals(binaryA)
          ? COMMIT_A
          : expected.equals(binaryB)
            ? COMMIT_B
            : 'aabbccddeeff';
        const expectedFingerprint = expected.equals(binaryC) ? wrong.fingerprint : key.fingerprint;
        assert.equal(
          fs.readFileSync(path.join(stateRoot, 'release-version'), 'utf8').trim(),
          expectedVersion,
          label,
        );
        assert.equal(
          fs.readFileSync(path.join(stateRoot, 'release-commit'), 'utf8').trim(),
          expectedCommit,
          label,
        );
        // The deliberately corrupted trust record has its own negative test.
        if (label !== 'corrupt local root') {
          assert.equal(
            fs.readFileSync(path.join(stateRoot, 'release-key-sha256'), 'utf8').trim(),
            expectedFingerprint,
            label,
          );
        }
        assert.deepEqual(fs.readFileSync(path.join(stateRoot, 'state.json')), identity);
        assert.deepEqual(fs.readFileSync(path.join(stateRoot, 'config.json')), config);
      }
      const first = await install();
      assert.equal(first.code, 0, 'signed fresh install: ' + first.output);
      assert.deepEqual(fs.readFileSync(installed), binaryA);
      assert.equal(
        fs.readFileSync(path.join(stateRoot, 'release-version'), 'utf8').trim(),
        VERSION_A,
      );
      assert.equal(
        fs.readFileSync(path.join(stateRoot, 'release-commit'), 'utf8').trim(),
        COMMIT_A,
      );
      assert.equal(
        fs.readFileSync(path.join(stateRoot, 'release-key-sha256'), 'utf8').trim(),
        key.fingerprint,
      );
      const identity = Buffer.from('test-only-identity-sentinel');
      const config = Buffer.from('test-only-config-sentinel');
      fs.writeFileSync(path.join(stateRoot, 'state.json'), identity);
      fs.writeFileSync(path.join(stateRoot, 'config.json'), config);
      await t.test('valid signed same-version reinstall', async () => {
        assert.equal((await install()).code, 0);
      });
      await t.test('leading-zero semantic version is rejected', async () => {
        await unchanged(
          'noncanonical version',
          install({
            version: '02.3.4',
            commit: COMMIT_A,
            publicKeyBase64: key.publicKeyBase64,
          }),
        );
      });
      await t.test('invalid pinned commit length is rejected', async () => {
        await unchanged(
          'short commit',
          install({
            version: VERSION_A,
            commit: 'deadbeef',
            publicKeyBase64: key.publicKeyBase64,
          }),
        );
      });
      await t.test('binary identity must match signed version and commit', async () => {
        active = bundle(key, file, binaryA, VERSION_B, COMMIT_B);
        await unchanged(
          'signed metadata with wrong binary identity',
          install({
            version: VERSION_B,
            commit: COMMIT_B,
            publicKeyBase64: key.publicKeyBase64,
          }),
        );
        active = packageA;
      });
      await t.test(
        'signed binary with correct version but wrong embedded commit is rejected',
        async () => {
          active = bundle(key, file, binaryWrongCommit, VERSION_B, COMMIT_B);
          await unchanged(
            'signed binary with wrong commit',
            install({
              version: VERSION_B,
              commit: COMMIT_B,
              publicKeyBase64: key.publicKeyBase64,
            }),
          );
          active = packageA;
        },
      );
      await t.test('modified binary', async () => {
        active = { ...packageA, binary: Buffer.concat([binaryA, Buffer.from('tamper')]) };
        await unchanged('modified binary', install());
        active = packageA;
      });
      await t.test('tampered SHA256SUMS', async () => {
        active = {
          ...packageA,
          sums: Buffer.from(packageA.sums.toString().replace(hash(binaryA), '0'.repeat(64))),
        };
        await unchanged('tampered manifest', install());
        active = packageA;
      });
      await t.test('missing signature', async () => {
        missingSignature = true;
        await unchanged('missing signature', install());
        missingSignature = false;
      });
      await t.test('wrong signature', async () => {
        const sig = Buffer.from(packageA.signature);
        sig[0] ^= 1;
        active = { ...packageA, signature: sig };
        await unchanged('wrong signature', install());
        active = packageA;
      });
      await t.test('public verification key mismatch', async () => {
        await unchanged(
          'wrong public key',
          install({
            version: VERSION_A,
            commit: COMMIT_A,
            publicKeyBase64: wrong.publicKeyBase64,
          }),
        );
      });
      await t.test('modified signed metadata bytes', async () => {
        active = { ...packageA, metadata: Buffer.from('version=0.0.0\ncommit=' + COMMIT_A + '\n') };
        await unchanged('metadata tamper', install());
        active = packageA;
      });
      await t.test('valid signature but mismatched release version', async () => {
        active = bundle(key, file, binaryA, VERSION_B, COMMIT_B);
        await unchanged('mismatched pin', install());
        active = packageA;
      });
      await t.test('manual rollback rejected', async () => {
        await unchanged(
          'manual rollback',
          install(undefined, { BOT_REPORT_WORKER_ACTION: 'rollback' }),
        );
      });
      await t.test('valid signed version upgrade', async () => {
        active = packageB;
        const upgraded = await install({
          version: VERSION_B,
          commit: COMMIT_B,
          publicKeyBase64: key.publicKeyBase64,
        });
        assert.equal(upgraded.code, 0, 'signed upgrade: ' + upgraded.output);
        assert.deepEqual(fs.readFileSync(installed), binaryB);
        assert.equal(
          fs.readFileSync(path.join(stateRoot, 'release-version'), 'utf8').trim(),
          VERSION_B,
        );
        assert.deepEqual(fs.readFileSync(path.join(stateRoot, 'state.json')), identity);
        assert.deepEqual(fs.readFileSync(path.join(stateRoot, 'config.json')), config);
      });
      await t.test('large semver components cannot round into an accepted downgrade', async () => {
        const releaseVersion = path.join(stateRoot, 'release-version');
        const savedVersion = fs.readFileSync(releaseVersion, 'utf8');
        const higherVersion = '9007199254740993.0.0';
        const lowerVersion = '9007199254740992.0.0';
        try {
          // A valid future release could have a semver component beyond JS/awk
          // floating-point precision; local installed records are authoritative.
          fs.writeFileSync(releaseVersion, higherVersion + '\n');
          active = bundle(
            key,
            file,
            await makeBinary(lowerVersion, COMMIT_B),
            lowerVersion,
            COMMIT_B,
          );
          const downgraded = await install({
            version: lowerVersion,
            commit: COMMIT_B,
            publicKeyBase64: key.publicKeyBase64,
          });
          assert.notEqual(downgraded.code, 0, 'rounded semver accepted a rollback');
          assert.match(downgraded.output, /rollback rejected/i);
          assert.deepEqual(fs.readFileSync(installed), binaryB);
          assert.equal(fs.readFileSync(releaseVersion, 'utf8'), higherVersion + '\n');
        } finally {
          fs.writeFileSync(releaseVersion, savedVersion);
          active = packageB;
        }
      });
      await t.test('previously valid signed release cannot downgrade', async () => {
        active = packageA;
        await unchanged('signed downgrade', install(), binaryB);
      });
      await t.test('failed signed upgrade restores previously installed binary', async () => {
        active = bundle(key, file, binaryD, '2.3.6', 'aabbccddeeff');
        await unchanged(
          'start failure rollback',
          install(
            { version: '2.3.6', commit: 'aabbccddeeff', publicKeyBase64: key.publicKeyBase64 },
            { SIGNED_TEST_RUNNING: '1', SIGNED_TEST_FAIL_START: '1' },
          ),
          binaryB,
        );
        assert.equal(
          fs.readFileSync(path.join(stateRoot, 'release-version'), 'utf8').trim(),
          VERSION_B,
        );
        assert.equal(
          fs.readFileSync(path.join(stateRoot, 'release-commit'), 'utf8').trim(),
          COMMIT_B,
        );
        active = packageB;
      });
      await t.test('same version with different signed commit is rejected', async () => {
        active = bundle(key, file, binaryB, VERSION_B, 'bbbbbbbbbbbb');
        await unchanged(
          'version reuse',
          install({
            version: VERSION_B,
            commit: 'bbbbbbbbbbbb',
            publicKeyBase64: key.publicKeyBase64,
          }),
          binaryB,
        );
      });
      const rotated = {
        version: '2.3.7',
        commit: 'aabbccddeeff',
        publicKeyBase64: wrong.publicKeyBase64,
      };
      await t.test('new signer is not trusted without an approved rotation', async () => {
        active = bundle(wrong, file, binaryC, rotated.version, rotated.commit);
        await unchanged('unapproved new root', install(rotated), binaryB);
        assert.equal(
          fs.readFileSync(path.join(stateRoot, 'release-key-sha256'), 'utf8').trim(),
          key.fingerprint,
        );
      });
      await t.test(
        'same-version key change is rejected even with old root allowlisted',
        async () => {
          active = bundle(wrong, file, binaryC, VERSION_B, COMMIT_B);
          await unchanged(
            'same-version rotation',
            install({
              ...rotated,
              version: VERSION_B,
              commit: COMMIT_B,
              previousPublicKeySha256: key.fingerprint,
            }),
            binaryB,
          );
        },
      );
      await t.test('explicit one-way owner-reviewed trust-root rotation', async () => {
        active = bundle(wrong, file, binaryC, rotated.version, rotated.commit);
        const result = await install({ ...rotated, previousPublicKeySha256: key.fingerprint });
        assert.equal(result.code, 0, 'approved rotation: ' + result.output);
        assert.deepEqual(fs.readFileSync(installed), binaryC);
        assert.equal(
          fs.readFileSync(path.join(stateRoot, 'release-key-sha256'), 'utf8').trim(),
          wrong.fingerprint,
        );
        assert.equal(
          fs.readFileSync(path.join(stateRoot, 'release-version'), 'utf8').trim(),
          rotated.version,
        );
      });
      await t.test('old trust root cannot silently take control after rotation', async () => {
        active = bundle(key, file, binaryA, '2.3.8', 'aabbccddeeff');
        await unchanged(
          'root regression',
          install({
            version: '2.3.8',
            commit: 'aabbccddeeff',
            publicKeyBase64: key.publicKeyBase64,
          }),
          binaryC,
        );
      });
      await t.test('rotation from an unlisted previous root fails closed', async () => {
        active = bundle(key, file, binaryA, '2.3.8', 'aabbccddeeff');
        await unchanged(
          'wrong rotation predecessor',
          install({
            version: '2.3.8',
            commit: 'aabbccddeeff',
            publicKeyBase64: key.publicKeyBase64,
            previousPublicKeySha256: '0'.repeat(64),
          }),
          binaryC,
        );
      });
      await t.test('corrupted installed trust record fails closed', async () => {
        fs.writeFileSync(path.join(stateRoot, 'release-key-sha256'), 'corrupt\n');
        active = bundle(wrong, file, binaryC, rotated.version, rotated.commit);
        await unchanged('corrupt local root', install(rotated), binaryC);
        fs.writeFileSync(path.join(stateRoot, 'release-key-sha256'), wrong.fingerprint + '\n');
      });
    } finally {
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

void test(
  'signer requires approved version, canonical checksums and RSA private key',
  {
    skip: process.platform !== 'linux' ? 'canonical SHA256SUMS signer runs on Linux' : false,
  },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-manifest-sign-'));
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-offline-key-'));
    try {
      const scripts = path.join(root, 'scripts');
      const bin = path.join(root, 'worker', 'bin');
      fs.mkdirSync(scripts, { recursive: true });
      fs.mkdirSync(bin, { recursive: true });
      const script = path.join(scripts, 'sign-worker-manifest.sh');
      fs.copyFileSync(path.join(__dirname, '../scripts/sign-worker-manifest.sh'), script);
      fs.writeFileSync(path.join(root, '.gitignore'), 'worker/bin/\n');
      for (const args of [
        ['init', '-q'],
        ['add', '.gitignore', 'scripts/sign-worker-manifest.sh'],
        [
          '-c',
          'user.name=Local Signed Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'local-test-source',
        ],
      ]) {
        const git = await execute('git', args, process.env, root);
        assert.equal(git.code, 0, git.output);
      }
      const head = await execute('git', ['rev-parse', 'HEAD'], process.env, root);
      assert.equal(head.code, 0, head.output);
      const approvedCommit = head.output.trim();
      const names = [
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
      for (const name of names) {
        fs.writeFileSync(
          path.join(bin, name),
          name === 'WORKER_RELEASE'
            ? 'version=' + VERSION_A + '\ncommit=' + approvedCommit + '\n'
            : name,
        );
      }
      function sums() {
        return names
          .map((name) => hash(fs.readFileSync(path.join(bin, name))) + '  ' + name + '\n')
          .join('');
      }
      fs.writeFileSync(path.join(bin, 'SHA256SUMS'), sums());
      const key = signer();
      const privatePath = path.join(privateDir, 'ephemeral-private.pem');
      fs.writeFileSync(privatePath, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
        mode: 0o600,
      });
      function sign(
        expectedVersion: string,
        privateFile = privatePath,
        commit = approvedCommit,
        fingerprint = key.fingerprint,
      ) {
        return execute(
          'sh',
          [script, privateFile],
          {
            ...process.env,
            WORKER_RELEASE_EXPECTED_VERSION: expectedVersion,
            WORKER_RELEASE_EXPECTED_COMMIT: commit,
            WORKER_RELEASE_EXPECTED_PUBLIC_KEY_SHA256: fingerprint,
          },
          root,
        );
      }
      assert.notEqual((await sign(VERSION_B)).code, 0, 'wrong approval version accepted');
      assert.notEqual(
        (await sign(VERSION_A, privatePath, approvedCommit, '')).code,
        0,
        'missing approved public-key fingerprint accepted',
      );
      assert.notEqual(
        (await sign(VERSION_A, privatePath, approvedCommit, '0'.repeat(64))).code,
        0,
        'signing key outside approved trust-root fingerprint accepted',
      );
      assert.notEqual(
        (await sign(VERSION_A, privatePath, '0123456')).code,
        0,
        'short commit accepted',
      );
      assert.notEqual((await sign('02.3.4')).code, 0, 'leading-zero version accepted');
      fs.writeFileSync(path.join(root, 'unexpected-source-file'), 'dirty');
      assert.notEqual((await sign(VERSION_A)).code, 0, 'dirty source tree signed');
      fs.rmSync(path.join(root, 'unexpected-source-file'));
      fs.writeFileSync(
        path.join(bin, 'WORKER_RELEASE'),
        'version=' + VERSION_A + '\ncommit=' + 'f'.repeat(40) + '\n',
      );
      fs.writeFileSync(path.join(bin, 'SHA256SUMS'), sums());
      assert.notEqual(
        (await sign(VERSION_A, privatePath, 'f'.repeat(40))).code,
        0,
        'unreviewed source commit signed',
      );
      fs.writeFileSync(
        path.join(bin, 'WORKER_RELEASE'),
        'version=' + VERSION_A + '\ncommit=' + approvedCommit + '\n',
      );
      fs.writeFileSync(path.join(bin, 'SHA256SUMS'), sums());
      const insideKey = path.join(root, 'private-in-source.pem');
      fs.copyFileSync(privatePath, insideKey);
      assert.notEqual(
        (await sign(VERSION_A, insideKey)).code,
        0,
        'signing key inside source accepted',
      );
      fs.rmSync(insideKey);
      fs.chmodSync(privatePath, 0o644);
      assert.notEqual((await sign(VERSION_A)).code, 0, 'world-readable key accepted');
      fs.chmodSync(privatePath, 0o600);
      assert.equal(fs.existsSync(path.join(bin, 'SHA256SUMS.sig')), false);
      const sumsPath = path.join(bin, 'SHA256SUMS');
      fs.renameSync(sumsPath, sumsPath + '.fixture');
      try {
        fs.symlinkSync('SHA256SUMS.fixture', sumsPath);
        assert.notEqual((await sign(VERSION_A)).code, 0, 'symlink manifest accepted');
      } finally {
        fs.rmSync(sumsPath);
        fs.renameSync(sumsPath + '.fixture', sumsPath);
      }
      fs.writeFileSync(
        path.join(bin, 'SHA256SUMS'),
        sums().replace(/^[0-9a-f]{64}/, '0'.repeat(64)),
      );
      assert.notEqual((await sign(VERSION_A)).code, 0, 'tampered checksum accepted');
      fs.writeFileSync(path.join(bin, 'SHA256SUMS'), sums());
      assert.equal((await sign(VERSION_A)).code, 0, 'signed candidate failed');
      const manifest = fs.readFileSync(path.join(bin, 'SHA256SUMS'));
      const signature = fs.readFileSync(path.join(bin, 'SHA256SUMS.sig'));
      assert.equal(crypto.verify('sha256', manifest, key.publicPem, signature), true);
      assert.notEqual(
        (await sign(VERSION_A)).code,
        0,
        'overwriting existing detached signature accepted',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(privateDir, { recursive: true, force: true });
    }
  },
);
