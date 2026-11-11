import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const compiled = path.resolve(__dirname, '..');

test('TS4 browser bundles are runnable as plain script tags without CommonJS', () => {
  for (const name of ['admin.js', 'terminal-console.js']) {
    const file = path.join(compiled, 'src/public', name);
    const script = fs.readFileSync(file, 'utf8');
    assert.ok(script.length > 100);
    assert.doesNotMatch(script, /Object\.defineProperty\(exports|\bmodule\.exports\b|\brequire\(/);
  }
});

test('TS4 compiled Worker and script layout retains installer endpoints', () => {
  for (const name of ['agent.js', 'cli.js', 'lifecycle.js']) {
    assert.ok(fs.statSync(path.join(compiled, 'worker', name)).isFile());
  }
  for (const name of ['first-mcp-call.js', 'init-bundled-db.js', 'migrate.js', 'terminal-profile.js', 'mcp-client.js']) {
    assert.ok(fs.statSync(path.join(compiled, 'scripts', name)).isFile());
  }
  assert.ok(fs.statSync(path.join(compiled, 'src/server.js')).isFile());
  assert.ok(fs.statSync(path.join(compiled, 'tests/standalone-install-smoke.js')).isFile());
  assert.ok(fs.statSync(path.join(compiled, 'tests/e2e/fixtures/start-test-server.js')).isFile());
  assert.ok(fs.statSync(path.join(compiled, 'playwright.config.js')).isFile());
});
