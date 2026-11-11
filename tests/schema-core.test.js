const test = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, cleanup, initDb } = require('./helper');

const env = setupEnv('schema');
test.after(() => cleanup(env.dir));

test('fresh compatibility database contains MCP, admin and worker support tables', () => {
  initDb();
  const db = require('../src/db/connection').getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
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
    'workers'
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
});

test('MySQL connection pool has a bounded wait queue and validates overrides', async () => {
  const { MysqlAdapter } = require('../src/db/adapters/mysqlAdapter');
  const config = { host: '127.0.0.1', username: 'fixture', password: 'unused', database: 'fixture' };
  const original = process.env.MYSQL_POOL_QUEUE_LIMIT;
  try {
    delete process.env.MYSQL_POOL_QUEUE_LIMIT;
    for (const [override, expected] of [[{}, 128], [{ queueLimit: 32 }, 32], [{ queueLimit: 0 }, 128], [{ queueLimit: 20_000 }, 128]]) {
      const adapter = MysqlAdapter.create({ ...config, ...override });
      try {
        assert.equal(adapter._db.pool.config.queueLimit, expected);
        assert.equal(adapter._db.pool.config.connectionLimit, 10);
      } finally {
        await adapter.close();
      }
    }
  } finally {
    if (original === undefined) delete process.env.MYSQL_POOL_QUEUE_LIMIT;
    else process.env.MYSQL_POOL_QUEUE_LIMIT = original;
  }
});

test('MySQL queue overload reports a 503 instead of an unbounded wait', async () => {
  const { MysqlAdapter } = require('../src/db/adapters/mysqlAdapter');
  const exhausted = () => { throw new Error('Queue limit reached.'); };
  const adapter = new MysqlAdapter({
    async execute() { exhausted(); },
    async getConnection() { exhausted(); }
  });
  const isBusy = error => error.code === 'MYSQL_POOL_BUSY' && error.status === 503;
  await assert.rejects(() => adapter.queryOne('SELECT 1'), isBusy);
  await assert.rejects(() => adapter.ping(), isBusy);
  await assert.rejects(() => adapter.transaction(async () => {}), isBusy);
});

test('migrations do not drop unknown legacy tables', () => {
  const db = require('../src/db/connection').getDb();
  db.exec('CREATE TABLE legacy_preserved (id TEXT PRIMARY KEY)');
  require('../src/db/migrations').runMigrations();
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_preserved'").get());
});
