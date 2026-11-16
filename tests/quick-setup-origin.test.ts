import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

void test('Quick Setup selects a trusted HTTPS IP or explicit hostname without touching Docker for invalid origins', () => {
  if (process.platform !== 'linux') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-quick-origin-'));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'docker-args');
  const script = path.resolve(process.cwd(), 'quick-setup.sh');
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
if [ "$1" = info ]; then exit 0; fi
if [ "$1" = container ] || [ "$1" = volume ]; then exit 1; fi
if [ "$1" = pull ]; then exit 0; fi
if [ "$1" = run ]; then printf '%s\\n' "$@" > "$QUICK_ORIGIN_LOG"; exit 77; fi
exit 88
`,
      { mode: 0o755 },
    );
    const run = (environment: Record<string, string>) => {
      fs.rmSync(log, { force: true });
      return spawnSync('sh', [script, '--init'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          QUICK_ORIGIN_LOG: log,
          MCP_WORKER_IMAGE: 'fixture-not-pulled',
          MCP_WORKER_TLS_MODE: 'external',
          MCP_WORKER_PUBLIC_URL: '',
          MCP_WORKER_PUBLIC_IP: '',
          MCP_WORKER_HTTPS_PORT: '',
          ...environment,
        },
      });
    };

    const ip = run({ MCP_WORKER_PUBLIC_IP: '36.50.27.45', MCP_WORKER_HTTPS_PORT: '3443' });
    assert.equal(ip.status, 77);
    assert.match(fs.readFileSync(log, 'utf8'), /MCP_PUBLIC_BASE_URL=https:\/\/36\.50\.27\.45:3443/);

    const ip443 = run({ MCP_WORKER_PUBLIC_IP: '36.50.27.45', MCP_WORKER_HTTPS_PORT: '443' });
    assert.equal(ip443.status, 77);
    assert.match(fs.readFileSync(log, 'utf8'), /MCP_PUBLIC_BASE_URL=https:\/\/36\.50\.27\.45\n/);

    const hostname = run({ MCP_WORKER_PUBLIC_URL: 'https://mcp.example.com' });
    assert.equal(hostname.status, 77);
    assert.match(fs.readFileSync(log, 'utf8'), /MCP_PUBLIC_BASE_URL=https:\/\/mcp\.example\.com/);

    for (const [env, expected] of [
      [{ MCP_WORKER_TLS_MODE: 'off' }, /MCP_WORKER_TLS_MODE must be auto or external/],
      [{ MCP_WORKER_PUBLIC_URL: 'http://mcp.example.com' }, /Explicit public URL must use HTTPS/],
      [{ MCP_WORKER_PUBLIC_URL: 'https://mcp.example.com/path' }, /bare IP\/hostname/],
      [{ MCP_WORKER_PUBLIC_IP: '192.168.1.20' }, /Private\/unusable host IP/],
      [{ MCP_WORKER_PUBLIC_IP: '36.50.27.45', MCP_WORKER_HTTPS_PORT: 'banana' }, /must be numeric/],
    ] as const) {
      const result = run(env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(fs.existsSync(log), false, 'invalid origin must fail before starting Docker');
    }
    assert.equal(fs.existsSync(path.join(root, '.env.setup')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
