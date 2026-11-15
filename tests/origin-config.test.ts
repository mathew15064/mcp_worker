import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRailwayOrigin } from '../src/config/railwayOrigin';

void test('canonical HTTPS origin rejects forged hosts and accepts owner custom host', () => {
  assert.equal(
    canonicalRailwayOrigin({ RAILWAY_PUBLIC_DOMAIN: 'owner.up.railway.app' }),
    'https://owner.up.railway.app',
  );
  assert.equal(
    canonicalRailwayOrigin({
      RAILWAY_PUBLIC_DOMAIN: 'owner.up.railway.app',
      MCP_PUBLIC_BASE_URL: 'https://my-worker.example.org',
    }),
    'https://my-worker.example.org',
  );
  assert.equal(canonicalRailwayOrigin({}), null);
  for (const value of [
    'attacker.example',
    'bad..up.railway.app',
    '-bad.up.railway.app',
    'bad-.up.railway.app',
    'railway.app',
    'owner.up.railway.app:1234',
    'owner.up.railway.app/evil',
  ]) {
    assert.throws(
      () => canonicalRailwayOrigin({ RAILWAY_PUBLIC_DOMAIN: value }),
      /Railway|Invalid/,
    );
  }
  assert.throws(
    () => canonicalRailwayOrigin({ MCP_PUBLIC_BASE_URL: 'http://example.org' }),
    /Invalid/,
  );
  assert.throws(
    () => canonicalRailwayOrigin({ MCP_PUBLIC_BASE_URL: 'https://u:p@example.org' }),
    /Invalid/,
  );
  for (const bad of [
    'my-worker.example.org',
    'https://my-worker.example.org:3000',
    'https://my-worker.example.org/redirect',
    'https://my-worker.example.org?token=123',
    'https://my-worker.example.org ',
    'https://my-worker.example.org\n',
  ]) {
    assert.throws(() => canonicalRailwayOrigin({ MCP_PUBLIC_BASE_URL: bad }), /Invalid/);
  }
  assert.throws(
    () => canonicalRailwayOrigin({ RAILWAY_PUBLIC_DOMAIN: 'owner.up.railway.app.attacker.test' }),
    /Railway/,
  );
});
