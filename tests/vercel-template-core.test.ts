import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import config from '../src/config/env';
import { postgresSql } from '../src/db/adapters/postgresAdapter';
import { SchemaBuilder } from '../src/db/schemaBuilder';
import type { DatabaseAdapter } from '../src/db/contracts';

void test('Postgres SQL retains bound values and adapts identifiers without interpolation', () => {
  const sql = postgresSql(
    `SELECT ` + '`key`, `value` FROM system_settings WHERE `key` = ? AND `value` = ?',
  );
  assert.equal(sql, 'SELECT "key", "value" FROM system_settings WHERE "key" = $1 AND "value" = $2');
  assert.equal(
    postgresSql('CREATE TABLE foo (enabled TINYINT(1), note LONGTEXT)'),
    'CREATE TABLE foo (enabled SMALLINT, note TEXT)',
  );
  assert.equal(
    postgresSql("SELECT '?' AS quoted, id FROM workers WHERE id = ?"),
    "SELECT '?' AS quoted, id FROM workers WHERE id = $1",
  );
  assert.equal(
    postgresSql('ALTER TABLE `workers` ADD INDEX `idx_workers` (`owner_user_id`)'),
    'CREATE INDEX IF NOT EXISTS "idx_workers" ON "workers" ("owner_user_id")',
  );
});

void test('SchemaBuilder uses PostgreSQL-native constraints and indexes', async () => {
  const statements: string[] = [];
  const db = {
    kind: 'postgres',
    exec: (sql: string) => {
      statements.push(postgresSql(sql));
      return Promise.resolve();
    },
  } as unknown as DatabaseAdapter;
  await new SchemaBuilder(db).createTable('test_worker', (t) => {
    t.string('id', 64).primary();
    t.string('name', 80);
    t.integer('enabled').default(1);
    t.index('enabled', 'idx_test_worker_enabled');
    t.unique('name', 'uq_test_worker_name');
  });
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CONSTRAINT "uq_test_worker_name" UNIQUE/);
  assert.match(statements[1], /CREATE INDEX IF NOT EXISTS "idx_test_worker_enabled"/);
  assert.doesNotMatch(statements[0], /ENGINE=InnoDB|UNIQUE KEY/);
});

void test('Each Vercel instance derives its own distinct stable keys from an owner-provided seed', () => {
  const before = { platform: process.env.MCP_PLATFORM, seed: process.env.MCP_SETUP_SECRET };
  try {
    process.env.MCP_PLATFORM = 'vercel';
    process.env.MCP_SETUP_SECRET = 'A'.repeat(43);
    const first = config.managedSecret('session', 64);
    const again = config.managedSecret('session', 64);
    const aes = config.managedSecret('aes-256-gcm', 32);
    assert.ok(first.equals(again));
    assert.notDeepEqual(first.subarray(0, 32), aes);
    process.env.MCP_SETUP_SECRET = 'B'.repeat(43);
    assert.notDeepEqual(config.managedSecret('session', 64), first);
    process.env.MCP_SETUP_SECRET = 'weak';
    assert.throws(() => config.managedSecret('session', 64), /random base64url/);
  } finally {
    if (before.platform === undefined) delete process.env.MCP_PLATFORM;
    else process.env.MCP_PLATFORM = before.platform;
    if (before.seed === undefined) delete process.env.MCP_SETUP_SECRET;
    else process.env.MCP_SETUP_SECRET = before.seed;
  }
});

void test('Vercel entrypoint has an explicit fail-closed prerequisite page, not a default admin', () => {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `
    for(const key of ['MCP_SETUP_SECRET','DATABASE_URL','POSTGRES_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','VERCEL_PROJECT_PRODUCTION_URL']) delete process.env[key];
    const server = require('./dist/api/index.js');
    server.listen(0,'127.0.0.1',async()=>{
      const res=await fetch('http://127.0.0.1:'+server.address().port+'/readyz');
      const body=await res.json();
      if(res.status!==503 || body.code!=='SETUP_PREREQUISITES_MISSING')process.exitCode=2;
      console.log('FAIL_CLOSED='+String(res.status)+' missing='+body.missing.length);
      server.close();
    });
  `,
    ],
    {
      encoding: 'utf8',
      timeout: 8000,
      cwd: process.cwd(),
      env: { ...process.env, MCP_PLATFORM: 'vercel' },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /FAIL_CLOSED=503/);
});
