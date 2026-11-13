import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const enabled = process.env.RAILWAY_DOCKER_INTEGRATION === '1';
const suppliedImage = process.env.RAILWAY_TEST_IMAGE;
const image = suppliedImage || 'mcp-railway-t02:' + crypto.randomBytes(5).toString('hex');
const suffix = crypto.randomBytes(5).toString('hex');
const container = 'mcp-railway-t02-' + suffix;
const volume = 'mcp-railway-t02-data-' + suffix;
function docker(...args: string[]) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 1024 * 1024,
  });
}
function check(...args: string[]) {
  const result = docker(...args);
  assert.equal(result.status, 0, ['docker', ...args, result.stderr].join(' '));
  return result.stdout.trim();
}

void test(
  'isolated Docker: missing/forged mount and readonly volume fail; fresh SQLite survives restart',
  { skip: !enabled, timeout: 900_000 },
  async () => {
    try {
      if (!suppliedImage) check('build', '-f', 'Dockerfile.railway', '-t', image, '.');
      const shared = [
        '-e',
        'MCP_PLATFORM=railway',
        '-e',
        'DATABASE_PATH=/app/data/bot_report.sqlite',
        '-e',
        'RAILWAY_VOLUME_MOUNT_PATH=/app/data',
      ];
      const missing = docker('run', '--rm', ...shared, '-e', 'RAILWAY_VOLUME_NAME=', image);
      assert.notEqual(missing.status, 0, 'missing volume identity must fail closed');
      const forged = docker('run', '--rm', ...shared, '-e', 'RAILWAY_VOLUME_NAME=forged', image);
      assert.notEqual(forged.status, 0, 'environment variables cannot fake a real mount');
      assert.match(forged.stderr, /not a mounted volume/i);

      check('volume', 'create', volume);
      const readonly = docker(
        'run',
        '--rm',
        '-v',
        volume + ':/app/data:ro',
        ...shared,
        '-e',
        'RAILWAY_VOLUME_NAME=' + volume,
        image,
      );
      assert.notEqual(readonly.status, 0, 'readonly volume must fail closed');

      // Validate all three SQLite file paths; none may redirect WAL/SHM to
      // ephemeral storage or elsewhere by way of a symlink.
      for (const filename of [
        'bot_report.sqlite',
        'bot_report.sqlite-wal',
        'bot_report.sqlite-shm',
      ]) {
        check(
          'run',
          '--rm',
          '--entrypoint',
          'sh',
          '-v',
          volume + ':/app/data',
          image,
          '-c',
          'ln -s /tmp/escape /app/data/' + filename,
        );
        const poisoned = docker(
          'run',
          '--rm',
          '-v',
          volume + ':/app/data',
          ...shared,
          '-e',
          'RAILWAY_VOLUME_NAME=' + volume,
          image,
        );
        assert.notEqual(poisoned.status, 0, filename + ' symlink must fail closed');
        assert.match(poisoned.stderr, /Unsafe SQLite file type or symlink/i);
        check(
          'run',
          '--rm',
          '--entrypoint',
          'sh',
          '-v',
          volume + ':/app/data',
          image,
          '-c',
          'rm /app/data/' + filename,
        );
      }

      const key = crypto.randomBytes(32).toString('base64url');
      check(
        'run',
        '-d',
        '--name',
        container,
        '-v',
        volume + ':/app/data',
        ...shared,
        '-e',
        'RAILWAY_VOLUME_NAME=' + volume,
        '-e',
        'RAILWAY_PUBLIC_DOMAIN=isolated-ci.up.railway.app',
        '-e',
        'MCP_SETUP_SECRET=' + key,
        image,
      );
      const probe = async () => {
        for (let i = 0; i < 60; i++) {
          const result = docker(
            'exec',
            container,
            'node',
            '-e',
            "fetch('http://127.0.0.1:80/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          );
          if (result.status === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        assert.fail('healthcheck failed: ' + docker('logs', container).stderr);
      };
      await probe();
      const uid = check('exec', container, 'sh', '-c', "awk '/^Uid:/ { print $2 }' /proc/1/status");
      assert.equal(uid, '1000', 'PID 1 must be the non-root node user');
      check('exec', container, 'test', '-f', '/app/data/bot_report.sqlite');
      check('restart', container);
      await probe();
      check('exec', container, 'test', '-f', '/app/data/bot_report.sqlite');
    } finally {
      docker('rm', '-f', container);
      docker('volume', 'rm', volume);
      if (!suppliedImage) docker('image', 'rm', image);
    }
  },
);
