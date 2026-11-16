import test from 'node:test';
import assert from 'node:assert/strict';
import helper from './helper';
import { getDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
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

void test('migrations do not drop unknown legacy tables', () => {
  const db = getDb();
  db.exec('CREATE TABLE legacy_preserved (id TEXT PRIMARY KEY)');
  runMigrations();
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_preserved'").get(),
  );
});
