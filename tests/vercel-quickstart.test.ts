import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Redis } from '@upstash/redis';
import {
  managedRedisConnection,
  managedRedis,
  canonicalVercelOrigin,
  hasManagedPostgres,
} from '../src/config/managedStorage';

void test('Vercel template requests both isolated managed stores', () => {
  const template = JSON.parse(fs.readFileSync('vercel-template.json', 'utf8')) as {
    products: Array<{
      type: string;
      protocol: string;
      productSlug: string;
      integrationSlug: string;
    }>;
  };
  assert.deepEqual(template.products, [
    { type: 'integration', protocol: 'storage', productSlug: 'neon', integrationSlug: 'neon' },
    {
      type: 'integration',
      protocol: 'storage',
      productSlug: 'upstash-kv',
      integrationSlug: 'upstash',
    },
  ]);
});

void test('Quickstart one-button link is tied to the reviewed branch, not main, and contains no credential values', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const guide = fs.readFileSync('docs/VERCEL_QUICKSTART.md', 'utf8');
  const match = readme.match(/\]\((https:\/\/vercel\.com\/new\/clone\?[^)\s]+)\)/);
  assert.ok(match, 'Deploy button missing from README');
  const url = new URL(match[1]);
  assert.equal(url.hostname, 'vercel.com');
  assert.equal(url.searchParams.get('env'), 'MCP_SETUP_SECRET');
  const repo = url.searchParams.get('repository-url');
  assert.equal(
    repo,
    'https://github.com/mathew15064/mcp_worker/tree/feature/vercel-selfhost-20261112',
  );
  assert.ok(!repo?.endsWith('/main'));
  assert.equal(url.searchParams.has('envDefaults'), false);
  const products = JSON.parse(url.searchParams.get('products') || '{}') as unknown;
  const manifest = JSON.parse(fs.readFileSync('vercel-template.json', 'utf8')) as {
    products: unknown;
  };
  assert.deepEqual(products, manifest.products);
  assert.ok(guide.includes(match[1]), 'Docs must use identical button URL');
  assert.ok(!url.toString().includes('MCP_SETUP_SECRET='), 'Setup secret must never appear in URL');
});

void test('Upstash Marketplace and legacy KV names are both supported without requesting manual credentials', () => {
  const direct = {
    UPSTASH_REDIS_REST_URL: 'https://direct.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'one',
  };
  const marketplace = { KV_REST_API_URL: 'https://market.upstash.io', KV_REST_API_TOKEN: 'two' };
  assert.deepEqual(managedRedisConnection(direct), {
    url: 'https://direct.upstash.io',
    token: 'one',
  });
  assert.deepEqual(managedRedisConnection(marketplace), {
    url: 'https://market.upstash.io',
    token: 'two',
  });
  assert.ok(managedRedis(marketplace) instanceof Redis);
  assert.equal(
    managedRedisConnection({ UPSTASH_REDIS_REST_URL: direct.UPSTASH_REDIS_REST_URL }),
    null,
  );
  assert.equal(managedRedisConnection({}), null);
  assert.throws(() => managedRedis({}), /Connect Upstash Redis/);
  assert.throws(
    () =>
      managedRedisConnection({ KV_REST_API_URL: 'http://unsafe.invalid', KV_REST_API_TOKEN: 'x' }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      managedRedisConnection({
        VERCEL: '1',
        KV_REST_API_URL: 'http://127.0.0.1:8979',
        KV_REST_API_TOKEN: 'x',
      }),
    /HTTPS/,
  );
  assert.deepEqual(
    managedRedisConnection({ KV_REST_API_URL: 'http://127.0.0.1:8979', KV_REST_API_TOKEN: 'x' }),
    { url: 'http://127.0.0.1:8979', token: 'x' },
  );
});

void test('Canonical Vercel URL is automatic and cannot be replaced with a supplied request host', () => {
  assert.equal(
    canonicalVercelOrigin({ VERCEL_URL: 'owner-preview-abc.vercel.app' }),
    'https://owner-preview-abc.vercel.app',
  );
  assert.equal(
    canonicalVercelOrigin({
      VERCEL_URL: 'old-preview.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'owner-app.vercel.app',
    }),
    'https://owner-app.vercel.app',
  );
  assert.equal(canonicalVercelOrigin({}), null);
  assert.throws(
    () => canonicalVercelOrigin({ VERCEL_URL: 'https://attacker.example/bad-path' }),
    /Invalid/,
  );
  assert.throws(
    () => canonicalVercelOrigin({ VERCEL_URL: 'https://user:pass@host.example' }),
    /Invalid/,
  );
  assert.equal(hasManagedPostgres({ POSTGRES_URL: 'postgresql://example' }), true);
  assert.equal(hasManagedPostgres({ DATABASE_URL: 'postgresql://example' }), true);
  assert.equal(hasManagedPostgres({}), false);
});
