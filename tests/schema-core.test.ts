import test from 'node:test';
import assert from 'node:assert/strict';
import helper from './helper';
import { getDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { MysqlAdapter } from '../src/db/adapters/mysqlAdapter';
const { setupEnv, cleanup, initDb } = helper;

const env = setupEnv('schema');
test.after(() => cleanup(env.dir));

void test('fresh compatibility database contains MCP, admin and worker support tables', () => {
  initDb();
  const db = getDb();
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    'mcp_oauth_access_tokens',
    'mcp_oauth_authorization_codes',
    'mcp_oauth_clients',
    'mcp_oauth_refresh_tokens',
    'mcp_request_audit',
    'sessions',
    'system_settings',
    'terminal_connection_audit',
    'terminal_profiles',
    'users',
    'worker_enrollment_tokens',
    'worker_profiles',
    'workers',
  ]);
  assert.equal(
    db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM users').get()?.count,
    0,
  );
});

void test('MySQL connection pool has a bounded wait queue and validates overrides', async () => {
  const config = {
    host: '127.0.0.1',
    username: 'fixture',
    password: 'unused',
    database: 'fixture',
  };
  const original = process.env.MYSQL_POOL_QUEUE_LIMIT;
  try {
    delete process.env.MYSQL_POOL_QUEUE_LIMIT;
    for (const [override, expected] of [
      [{}, 128],
      [{ queueLimit: 32 }, 32],
      [{ queueLimit: 0 }, 128],
      [{ queueLimit: 20_000 }, 128],
    ] as const) {
      const adapter = MysqlAdapter.create({ ...config, ...override });
      try {
        const pool = (
          adapter as unknown as {
            _db: { pool: { config: { queueLimit: number; connectionLimit: number } } };
          }
        )._db.pool;
        assert.equal(pool.config.queueLimit, expected);
        assert.equal(pool.config.connectionLimit, 10);
      } finally {
        await adapter.close();
      }
    }
  } finally {
    if (original === undefined) delete process.env.MYSQL_POOL_QUEUE_LIMIT;
    else process.env.MYSQL_POOL_QUEUE_LIMIT = original;
  }
});

void test('MySQL queue overload reports a 503 instead of an unbounded wait', async () => {
  const exhausted = () => {
    throw new Error('Queue limit reached.');
  };
  const connection = {
    async execute() {
      exhausted();
    },
    async getConnection() {
      exhausted();
    },
  };
  const adapter = new MysqlAdapter(
    connection as unknown as ConstructorParameters<typeof MysqlAdapter>[0],
  );
  const isBusy = (error: unknown) =>
    error instanceof Error &&
    'code' in error &&
    error.code === 'MYSQL_POOL_BUSY' &&
    'status' in error &&
    error.status === 503;
  await assert.rejects(() => adapter.queryOne('SELECT 1'), isBusy);
  await assert.rejects(() => adapter.ping(), isBusy);
  await assert.rejects(() => adapter.transaction(async () => {}), isBusy);
});

void test('migrations do not drop unknown legacy tables', () => {
  const db = getDb();
  db.exec('CREATE TABLE legacy_preserved (id TEXT PRIMARY KEY)');
  runMigrations();
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_preserved'").get(),
  );
});
