import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const compiled = path.resolve(__dirname, '..');

void test('TS4 browser bundles are runnable as plain script tags without CommonJS', () => {
  for (const name of ['admin.js', 'terminal-console.js']) {
    const file = path.join(compiled, 'src/public', name);
    const script = fs.readFileSync(file, 'utf8');
    assert.ok(script.length > 100);
    assert.doesNotMatch(script, /Object\.defineProperty\(exports|\bmodule\.exports\b|\brequire\(/);
  }
});

void test('TS4 compiled Worker and script layout retains installer endpoints', () => {
  for (const name of ['agent.js', 'cli.js', 'lifecycle.js']) {
    assert.ok(fs.statSync(path.join(compiled, 'worker', name)).isFile());
  }
  for (const name of [
    'first-mcp-call.js',
    'init-bundled-db.js',
    'migrate.js',
    'terminal-profile.js',
    'mcp-client.js',
  ]) {
    assert.ok(fs.statSync(path.join(compiled, 'scripts', name)).isFile());
  }
  assert.ok(fs.statSync(path.join(compiled, 'src/server.js')).isFile());
  assert.ok(fs.statSync(path.join(compiled, 'tests/standalone-install-smoke.js')).isFile());
  assert.ok(fs.statSync(path.join(compiled, 'tests/e2e/fixtures/start-test-server.js')).isFile());
  // The browser config is required in developer/CI builds, but deliberately
  // omitted from the production runtime image together with Playwright itself.
  const playwrightConfig = path.join(compiled, 'playwright.config.js');
  let hasPlaywrightDevDependency = false;
  try {
    require.resolve('@playwright/test');
    hasPlaywrightDevDependency = true;
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'MODULE_NOT_FOUND'
    )
      throw error;
  }
  if (hasPlaywrightDevDependency) {
    assert.ok(
      fs.statSync(playwrightConfig).isFile(),
      'Developer build must include the compiled browser config',
    );
  } else {
    assert.equal(
      fs.existsSync(playwrightConfig),
      false,
      'Production image must not ship Playwright config',
    );
  }
});
