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
import { workerSignedReleaseReadiness } from '../src/services/workerReleaseGate';

type ApprovedRelease = {
  version: string;
  commit: string;
  publicKeyBase64: string;
  publicKeySha256: string;
  previousPublicKeySha256?: string;
};
type Installer = (
  baseUrl: string,
  approval?: ApprovedRelease,
  systemdPaths?: { binary: string; unit: string },
) => string;
type WorkerRouteApi = {
  installerScript: Installer;
  macInstallerScript: Installer;
  windowsInstallerScript: Installer;
  windowsInstallerPayloadScript: Installer;
};
const workerRoutes = createRequire(__filename)('../src/routes/workerRoutes') as WorkerRouteApi;

const VERSION_A = '2.3.4';
const COMMIT_A = '0123456789abcdef0123456789abcdef01234567';
const VERSION_B = '2.3.5';
const COMMIT_B = '1122334455667788990011223344556677889900';

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
  // A real release must carry the complete, ordered eight-platform inventory.
  const platforms = [
    'worker_mcp-darwin-amd64',
    'worker_mcp-darwin-arm64',
    'worker_mcp-linux-386',
    'worker_mcp-linux-amd64',
    'worker_mcp-linux-arm64',
    'worker_mcp-linux-armv7',
    'worker_mcp-windows-amd64.exe',
    'worker_mcp-windows-arm64.exe',
  ];
  const sums = Buffer.from(
    platforms
      .map(
        (name) =>
          hash(name === file ? binary : Buffer.from('test-only-placeholder:' + name)) +
          '  ' +
          name +
          '\n',
      )
      .join('') +
      hash(metadata) +
      '  WORKER_RELEASE\n',
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

void test('read-only source gate cannot self-authorize a production release', () => {
  assert.deepEqual(workerSignedReleaseReadiness(), {
    code: 'WORKER_SIGNED_RELEASE_PENDING',
    decision: 'NO_GO',
    signingKeyApproved: false,
    signedArtifactsApproved: false,
    productionDistributionApproved: false,
    installerHttpStatus: 503,
  });
  assert.equal(Object.isFrozen(workerSignedReleaseReadiness()), true);
});

void test('no approved release is embedded in any downloadable installer', () => {
  for (const source of [
    workerRoutes.installerScript('https://example.test'),
    workerRoutes.macInstallerScript('https://example.test'),
    workerRoutes.windowsInstallerScript('https://example.test'),
    workerRoutes.windowsInstallerPayloadScript('https://example.test'),
  ]) {
    assert.match(source, /[Ss]igned release not approved/);
    assert.doesNotMatch(source, /openssl dgst -sha256 -verify \$env:MCP_WORKER_WORKER_TRUSTED_KEY/);
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
  // Source-level checks only: actual PowerShell lifecycle needs native Windows.
  assert.match(windows, /\[IO\.File\]::ReadAllBytes\(\$Metadata\)/);
  assert.match(windows, /version=\$PinnedVersion`ncommit=\$PinnedCommit`n/);
  assert.match(windows, /\[string\]::CompareOrdinal/);
  assert.doesNotMatch(windows, /if \(\[version\]\$PinnedVersion/);
});

void test('Worker installer and binary distribution stay HTTP 503 without approval', async () => {
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
    // Any platform flag, including an unset/typo value, must fail closed.
    // A runtime environment variable is never signed-release authorization.
    for (const platform of [undefined, '', 'dev', 'invalid', 'local']) {
      if (platform === undefined) delete process.env.MCP_PLATFORM;
      else process.env.MCP_PLATFORM = platform;
      for (const endpoint of [
        '/worker/install.sh',
        '/worker/install-linux.sh',
        '/worker/install-macos.sh',
        '/worker/install.ps1',
        '/worker/install-windows.ps1',
        '/worker/dist/SHA256SUMS',
        '/worker/dist/SHA256SUMS.sig',
        '/worker/dist/WORKER_RELEASE',
        '/worker/dist/worker_mcp-linux-amd64',
        '/worker/dist/cli.js',
      ]) {
        const response: Response = await fetch('http://127.0.0.1:' + address.port + endpoint);
        assert.equal(response.status, 503, `${String(platform)}: ${endpoint}`);
        assert.equal(response.headers.get('cache-control'), 'no-store', endpoint);
        const body = (await response.json()) as { code: string };
        assert.equal(body.code, 'WORKER_SIGNED_RELEASE_PENDING', endpoint);
      }
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
    const file = 'worker_mcp-' + (win ? 'windows-' + arch + '.exe' : process.platform + '-' + arch);
    const installed = path.join(root, 'install', 'current', win ? 'worker_mcp.exe' : 'worker_mcp');
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
          ' case "version": fmt.Printf("worker_mcp %s commit=%s runtime=stub windows/amd64\\n", version, commit)',
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
          ' version) printf "worker_mcp ' +
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
    const binaryC = await makeBinary('2.3.7', 'aabbccddeeff00112233445566778899aabbccdd');
    const binaryD = await makeBinary('2.3.6', 'aabbccddeeff00112233445566778899aabbccdd');
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
        MCP_WORKER_WORKER_HOME: stateRoot,
        MCP_WORKER_WORKER_INSTALL_ROOT: path.join(root, 'install'),
        MCP_WORKER_WORKER_BIN_DIR: path.join(root, 'bin'),
        MCP_WORKER_WORKER_SYSTEMD: '0',
        MCP_WORKER_WORKER_SKIP_SERVICE: '1',
        MCP_WORKER_WORKER_SKIP_PATH: '1',
      };
      async function install(
        approval: ApprovedRelease = {
          version: VERSION_A,
          commit: COMMIT_A,
          publicKeyBase64: key.publicKeyBase64,
          publicKeySha256: key.fingerprint,
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
            : 'aabbccddeeff00112233445566778899aabbccdd';
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
      assert.equal(
        fs.readFileSync(path.join(stateRoot, 'release-manifest-sha256'), 'utf8').trim(),
        hash(packageA.sums),
      );
      const identity = Buffer.from('test-only-identity-sentinel');
      const config = Buffer.from('test-only-config-sentinel');
      fs.writeFileSync(path.join(stateRoot, 'state.json'), identity);
      fs.writeFileSync(path.join(stateRoot, 'config.json'), config);
      await t.test('valid signed same-version reinstall', async () => {
        assert.equal((await install()).code, 0);
      });
      await t.test('signed same version and commit cannot replay altered manifest', async () => {
        active = bundle(
          key,
          file,
          Buffer.concat([binaryA, Buffer.from('\n# different build\n')]),
          VERSION_A,
          COMMIT_A,
        );
        await unchanged('same-version manifest replay', install());
        active = packageA;
      });
      await t.test('signed noncanonical inventory with valid signature is rejected', async () => {
        for (const invalid of [
          packageA.sums.toString().split('\n').slice(0, -2).join('\n') + '\n',
          packageA.sums.toString() + hash('unexpected') + '  extra-file\n',
          packageA.sums.toString().replace('worker_mcp-linux-386', '../unauthorized-file'),
          packageA.sums.toString().replace('worker_mcp-darwin-amd64', 'worker_mcp-Darwin-amd64'),
        ]) {
          const sums = Buffer.from(invalid);
          active = { ...packageA, sums, signature: crypto.sign('sha256', sums, key.privateKey) };
          await unchanged('noncanonical signed inventory', install());
        }
        active = packageA;
      });
      await t.test(
        'approved fingerprint mismatch is rejected independent of key bytes',
        async () => {
          await unchanged(
            'wrong pinned SPKI digest',
            install({
              version: VERSION_A,
              commit: COMMIT_A,
              publicKeyBase64: key.publicKeyBase64,
              publicKeySha256: wrong.fingerprint,
            }),
          );
        },
      );
      await t.test('abbreviated SHA is rejected despite valid signature', async () => {
        await unchanged(
          'short source SHA',
          install({
            version: VERSION_A,
            commit: COMMIT_A.slice(0, 12),
            publicKeyBase64: key.publicKeyBase64,
            publicKeySha256: key.fingerprint,
          }),
        );
      });
      await t.test('leading-zero semantic version is rejected', async () => {
        await unchanged(
          'noncanonical version',
          install({
            version: '02.3.4',
            commit: COMMIT_A,
            publicKeyBase64: key.publicKeyBase64,
            publicKeySha256: key.fingerprint,
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
            publicKeySha256: key.fingerprint,
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
            publicKeySha256: key.fingerprint,
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
              publicKeySha256: key.fingerprint,
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
            publicKeySha256: wrong.fingerprint,
          }),
        );
      });
      await t.test('modified signed metadata bytes', async () => {
        active = { ...packageA, metadata: Buffer.from('version=0.0.0\ncommit=' + COMMIT_A + '\n') };
        await unchanged('metadata tamper', install());
        active = packageA;
      });
      await t.test('validly signed but noncanonical metadata bytes are rejected', async () => {
        for (const metadata of [
          Buffer.from('version=' + VERSION_A + '\r\ncommit=' + COMMIT_A + '\r\n'),
          Buffer.from('version=' + VERSION_A + '\ncommit=' + COMMIT_A),
          Buffer.from('version=' + VERSION_A + '\ncommit=' + COMMIT_A + '\n\n'),
          Buffer.from('version=' + VERSION_A + '\ncommit=' + COMMIT_A + '\n\0'),
        ]) {
          const sums = Buffer.from(
            packageA.sums.toString().replace(hash(packageA.metadata), hash(metadata)),
          );
          active = {
            ...packageA,
            metadata,
            sums,
            signature: crypto.sign('sha256', sums, key.privateKey),
          };
          await unchanged('signed metadata bytes', install());
        }
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
          install(undefined, { MCP_WORKER_WORKER_ACTION: 'rollback' }),
        );
      });
      await t.test('valid signed version upgrade', async () => {
        active = packageB;
        const upgraded = await install({
          version: VERSION_B,
          commit: COMMIT_B,
          publicKeyBase64: key.publicKeyBase64,
          publicKeySha256: key.fingerprint,
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
            publicKeySha256: key.fingerprint,
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
        active = bundle(key, file, binaryD, '2.3.6', 'aabbccddeeff00112233445566778899aabbccdd');
        await unchanged(
          'start failure rollback',
          install(
            {
              version: '2.3.6',
              commit: 'aabbccddeeff00112233445566778899aabbccdd',
              publicKeyBase64: key.publicKeyBase64,
              publicKeySha256: key.fingerprint,
            },
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
        active = bundle(key, file, binaryB, VERSION_B, 'bbbbbbbbbbbb1111222233334444555566667777');
        await unchanged(
          'version reuse',
          install({
            version: VERSION_B,
            commit: 'bbbbbbbbbbbb1111222233334444555566667777',
            publicKeyBase64: key.publicKeyBase64,
            publicKeySha256: key.fingerprint,
          }),
          binaryB,
        );
      });
      const rotated = {
        version: '2.3.7',
        commit: 'aabbccddeeff00112233445566778899aabbccdd',
        publicKeyBase64: wrong.publicKeyBase64,
        publicKeySha256: wrong.fingerprint,
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
        active = bundle(key, file, binaryA, '2.3.8', 'aabbccddeeff00112233445566778899aabbccdd');
        await unchanged(
          'root regression',
          install({
            version: '2.3.8',
            commit: 'aabbccddeeff00112233445566778899aabbccdd',
            publicKeyBase64: key.publicKeyBase64,
            publicKeySha256: key.fingerprint,
          }),
          binaryC,
        );
      });
      await t.test('rotation from an unlisted previous root fails closed', async () => {
        active = bundle(key, file, binaryA, '2.3.8', 'aabbccddeeff00112233445566778899aabbccdd');
        await unchanged(
          'wrong rotation predecessor',
          install({
            version: '2.3.8',
            commit: 'aabbccddeeff00112233445566778899aabbccdd',
            publicKeyBase64: key.publicKeyBase64,
            publicKeySha256: key.fingerprint,
            previousPublicKeySha256: '0'.repeat(64),
          }),
          binaryC,
        );
      });
      await t.test('corrupted installed manifest record fails closed', async () => {
        const record = path.join(stateRoot, 'release-manifest-sha256');
        const prior = fs.readFileSync(record);
        try {
          fs.writeFileSync(record, 'not-a-sha256\n');
          active = bundle(wrong, file, binaryC, rotated.version, rotated.commit);
          await unchanged('corrupt recorded manifest', install(rotated), binaryC);
        } finally {
          fs.writeFileSync(record, prior);
        }
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
        'worker_mcp-darwin-amd64',
        'worker_mcp-darwin-arm64',
        'worker_mcp-linux-386',
        'worker_mcp-linux-amd64',
        'worker_mcp-linux-arm64',
        'worker_mcp-linux-armv7',
        'worker_mcp-windows-amd64.exe',
        'worker_mcp-windows-arm64.exe',
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
      assert.notEqual(
        (await sign(VERSION_A, privatePath, approvedCommit.slice(0, 12))).code,
        0,
        'abbreviated approved commit accepted',
      );
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
      for (const badMetadata of [
        'version=' + VERSION_A + '\r\ncommit=' + approvedCommit + '\r\n',
        'version=' + VERSION_A + '\ncommit=' + approvedCommit,
        'version=' + VERSION_A + '\ncommit=' + approvedCommit + '\n\n',
      ]) {
        fs.writeFileSync(path.join(bin, 'WORKER_RELEASE'), badMetadata);
        fs.writeFileSync(path.join(bin, 'SHA256SUMS'), sums());
        assert.notEqual((await sign(VERSION_A)).code, 0, 'noncanonical metadata signed');
      }
      fs.writeFileSync(
        path.join(bin, 'WORKER_RELEASE'),
        'version=' + VERSION_A + '\ncommit=' + approvedCommit + '\n',
      );
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

void test(
  'disposable systemd upgrade restores worker_mcp binary, unit and signed records on failure',
  {
    skip: process.platform !== 'linux' ? 'systemd shell simulation requires Linux' : false,
    timeout: 180000,
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-systemd-transaction-'));
    const key = signer();
    const file = 'worker_mcp-linux-' + (process.arch === 'arm64' ? 'arm64' : 'amd64');
    const target = path.join(root, 'install', 'current', 'worker_mcp');
    const serviceBinary = path.join(root, 'fake-systemd', 'sbin', 'worker_mcp');
    const serviceUnit = path.join(root, 'fake-systemd', 'units', 'worker_mcp.service');
    const workerHome = path.join(root, 'identity');
    const mockState = path.join(root, 'mock-state');
    const mockBin = path.join(root, 'mock-bin');
    const aliasBin = path.join(root, 'aliases');
    const metadataPaths = [
      'release-version',
      'release-commit',
      'release-key-sha256',
      'release-manifest-sha256',
      'service-mode',
      'default-server',
      'install-root',
      'bin-path',
    ];
    for (const dir of [
      path.dirname(serviceBinary),
      path.dirname(serviceUnit),
      workerHome,
      mockState,
      mockBin,
      aliasBin,
    ])
      fs.mkdirSync(dir, { recursive: true });
    function binary(version: string, commit: string) {
      return Buffer.from(
        [
          '#!/bin/sh',
          'case "$1" in',
          ' version) echo "worker_mcp ' +
            version +
            ' commit=' +
            commit +
            ' runtime=stub linux/amd64";;',
          ' status) echo "status: RUNNING";;',
          ' start|stop) exit 0;;',
          ' *) exit 0;;',
          'esac',
          '',
        ].join('\n'),
      );
    }
    const commitC = 'aabbccddeeff00112233445566778899aabbccdd';
    const packageA = bundle(key, file, binary(VERSION_A, COMMIT_A), VERSION_A, COMMIT_A);
    const packageB = bundle(key, file, binary(VERSION_B, COMMIT_B), VERSION_B, COMMIT_B);
    const packageC = bundle(key, file, binary('2.3.6', commitC), '2.3.6', commitC);
    let active = packageA;
    const systemctlMock = [
      '#!/bin/sh',
      'set -eu',
      'STATE="$MOCK_SYSTEMCTL_STATE"',
      'case "$1" in',
      ' --version) echo "systemd 252";;',
      ' cat) [ -f "$MOCK_SERVICE_UNIT" ];;',
      ' is-enabled) [ -f "$STATE/enabled" ];;',
      ' is-active) [ -f "$STATE/active" ];;',
      ' daemon-reload) exit 0;;',
      ' enable) touch "$STATE/enabled";;',
      ' disable) rm -f "$STATE/enabled";;',
      ' stop) rm -f "$STATE/active";;',
      ' start|restart)',
      '   echo "$1" >> "$STATE/starts"',
      '   if [ -f "$STATE/fail-start" ] && grep -Fq "worker_mcp 2.3.5 commit=" "$MOCK_SERVICE_BINARY"; then',
      '     rm -f "$STATE/active"; exit 9',
      '   fi',
      '   touch "$STATE/active";;',
      ' show)',
      '   if [ -f "$STATE/fail-ready" ] && grep -Fq "worker_mcp 2.3.6 commit=" "$MOCK_SERVICE_BINARY"; then',
      '     echo 0',
      '   else',
      '     echo 4321',
      '   fi;;',
      ' *) echo "Unexpected mock systemctl command: $*" >&2; exit 2;;',
      'esac',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(mockBin, 'systemctl'), systemctlMock, { mode: 0o755 });
    fs.writeFileSync(
      path.join(mockBin, 'id'),
      '#!/bin/sh\nif [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi\n',
      { mode: 0o755 },
    );
    const server = http.createServer((req, res) => {
      const contents =
        req.url === '/worker/dist/' + file
          ? active.binary
          : req.url === '/worker/dist/WORKER_RELEASE'
            ? active.metadata
            : req.url === '/worker/dist/SHA256SUMS'
              ? active.sums
              : req.url === '/worker/dist/SHA256SUMS.sig'
                ? active.signature
                : null;
      if (!contents) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(contents);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const addr = server.address();
      assert.ok(addr && typeof addr !== 'string');
      const base = 'http://127.0.0.1:' + addr.port;
      const env = {
        ...process.env,
        HOME: root,
        PATH: mockBin + ':' + process.env.PATH,
        MCP_WORKER_WORKER_INSTALL_ROOT: path.join(root, 'install'),
        MCP_WORKER_WORKER_HOME: workerHome,
        MCP_WORKER_WORKER_BIN_DIR: aliasBin,
        MCP_WORKER_WORKER_SYSTEMD: '1',
        MCP_WORKER_WORKER_SKIP_SERVICE: '0',
        MOCK_SYSTEMCTL_STATE: mockState,
        MOCK_SERVICE_BINARY: serviceBinary,
        MOCK_SERVICE_UNIT: serviceUnit,
      };
      const approval = (version: string, commit: string): ApprovedRelease => ({
        version,
        commit,
        publicKeyBase64: key.publicKeyBase64,
        publicKeySha256: key.fingerprint,
      });
      async function install(version: string, commit: string, managed = true) {
        const script = workerRoutes.installerScript(base, approval(version, commit), {
          binary: serviceBinary,
          unit: serviceUnit,
        });
        const filename = path.join(root, 'install.sh');
        fs.writeFileSync(filename, script);
        return execute('sh', [filename], {
          ...env, MCP_WORKER_WORKER_SYSTEMD: managed ? '1' : '0',
        }, root);
      }
      function signedState(expected: Package, version: string, commit: string, isActive: boolean) {
        assert.deepEqual(fs.readFileSync(target), expected.binary, 'local verified runtime');
        assert.deepEqual(fs.readFileSync(serviceBinary), expected.binary, 'systemd runtime');
        assert.equal(
          fs.readFileSync(path.join(workerHome, 'release-version'), 'utf8'),
          version + '\n',
        );
        assert.equal(
          fs.readFileSync(path.join(workerHome, 'release-commit'), 'utf8'),
          commit + '\n',
        );
        assert.equal(
          fs.readFileSync(path.join(workerHome, 'release-key-sha256'), 'utf8'),
          key.fingerprint + '\n',
        );
        assert.equal(
          fs.readFileSync(path.join(workerHome, 'release-manifest-sha256'), 'utf8'),
          hash(expected.sums) + '\n',
        );
        assert.equal(fs.existsSync(path.join(mockState, 'active')), isActive);
        assert.equal(fs.readlinkSync(path.join(aliasBin, 'worker_mcp')), target);
      }
      // Migrate a verified manual installation to the system service without
      // deleting the signed runtime or generating a second Worker identity.
      const manual = await install(VERSION_A, COMMIT_A, false);
      assert.equal(manual.code, 0, 'fresh manual installation: ' + manual.output);
      assert.equal(fs.existsSync(serviceUnit), false);
      assert.equal(fs.existsSync(path.join(workerHome, 'service-mode')), false);
      const first = await install(VERSION_A, COMMIT_A);
      assert.equal(first.code, 0, 'manual-to-systemd migration: ' + first.output);
      signedState(packageA, VERSION_A, COMMIT_A, false);
      fs.writeFileSync(path.join(workerHome, 'state.json'), 'test-only-enrollment');
      const initialUnit = fs.readFileSync(serviceUnit);
      assert.match(initialUnit.toString('utf8'), /ConditionPathExists=.*\/state\.json/);
      assert.match(initialUnit.toString('utf8'), /Restart=on-failure/);
      assert.match(initialUnit.toString('utf8'), /NoNewPrivileges=true/);
      assert.match(initialUnit.toString('utf8'), /WantedBy=multi-user\.target/);
      const initialRecords = metadataPaths.map((name) =>
        fs.readFileSync(path.join(workerHome, name)),
      );
      active = packageB;
      await t.test(
        'activation failure compensates to previous inactive verified state',
        async () => {
          fs.writeFileSync(path.join(mockState, 'fail-start'), '');
          const failed = await install(VERSION_B, COMMIT_B);
          assert.notEqual(failed.code, 0, failed.output);
          assert.match(failed.output, /rollback attempted/);
          fs.rmSync(path.join(mockState, 'fail-start'));
          signedState(packageA, VERSION_A, COMMIT_A, false);
          assert.deepEqual(fs.readFileSync(serviceUnit), initialUnit);
          metadataPaths.forEach((name, i) =>
            assert.deepEqual(fs.readFileSync(path.join(workerHome, name)), initialRecords[i], name),
          );
        },
      );
      await t.test('retry activates and identical reinstallation is idempotent', async () => {
        const ok = await install(VERSION_B, COMMIT_B);
        assert.equal(ok.code, 0, ok.output);
        signedState(packageB, VERSION_B, COMMIT_B, true);
        const starts = fs.readFileSync(path.join(mockState, 'starts'));
        const retry = await install(VERSION_B, COMMIT_B);
        assert.equal(retry.code, 0, retry.output);
        assert.deepEqual(
          fs.readFileSync(path.join(mockState, 'starts')),
          starts,
          'idempotent retry restarted an active verified service',
        );
      });
      await t.test(
        'readiness timeout restores active prior service and prior signed records',
        async () => {
          fs.appendFileSync(serviceUnit, '# retained prior unit marker\n');
          const priorUnit = fs.readFileSync(serviceUnit);
          const priorRecords = metadataPaths.map((name) =>
            fs.readFileSync(path.join(workerHome, name)),
          );
          const previous = fs.readFileSync(path.join(root, 'install', 'previous', 'worker_mcp'));
          active = packageC;
          fs.writeFileSync(path.join(mockState, 'fail-ready'), '');
          const failed = await install('2.3.6', commitC);
          assert.notEqual(failed.code, 0, failed.output);
          assert.match(failed.output, /readiness|restore/i);
          fs.rmSync(path.join(mockState, 'fail-ready'));
          signedState(packageB, VERSION_B, COMMIT_B, true);
          assert.deepEqual(fs.readFileSync(serviceUnit), priorUnit, 'original systemd unit');
          assert.deepEqual(
            fs.readFileSync(path.join(root, 'install', 'previous', 'worker_mcp')),
            previous,
            'previous rollback slot retained',
          );
          metadataPaths.forEach((name, i) =>
            assert.deepEqual(fs.readFileSync(path.join(workerHome, name)), priorRecords[i], name),
          );
          const retried = await install('2.3.6', commitC);
          assert.equal(retried.code, 0, retried.output);
          signedState(packageC, '2.3.6', commitC, true);
        },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
