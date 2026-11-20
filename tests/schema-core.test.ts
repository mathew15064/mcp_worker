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

void test('legacy Worker databases migrate additively to owner-scoped names and modes', () => {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`CREATE TABLE workers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL,
      capabilities_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'offline', last_seen_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_workers_name_nocase ON workers(name COLLATE NOCASE);
    INSERT INTO workers (id, name, public_key, capabilities_json, created_at, updated_at)
      VALUES ('legacy-1', 'Worker', 'key', '[]', '2026-01-01', '2026-01-01');`);
    runMigrations(legacy);
    runMigrations(legacy); // restarting an upgraded gateway must remain safe
    const stored = legacy.prepare('SELECT name, owner_user_id, execution_mode FROM workers WHERE id = ?')
      .get('legacy-1') as { name: string; owner_user_id: string | null; execution_mode: string };
    assert.deepEqual(stored, { name: 'Worker', owner_user_id: null, execution_mode: 'legacy' });
    const names = legacy.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ?')
      .all('index', 'idx_workers_%') as { name: string }[];
    assert.equal(names.some((item) => item.name === 'idx_workers_name_nocase'), false);
    assert.equal(names.some((item) => item.name === 'idx_workers_owner_name_nocase'), true);
    assert.equal(names.some((item) => item.name === 'idx_workers_admin_name_nocase'), true);
  } finally {
    legacy.close();
  }
});

void test('migrations do not drop unknown legacy tables', () => {
  const db = getDb();
  db.exec('CREATE TABLE legacy_preserved (id TEXT PRIMARY KEY)');
  runMigrations();
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_preserved'").get(),
  );
});
