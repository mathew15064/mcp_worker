import test from 'node:test';
import assert from 'node:assert/strict';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { MigrationRunner, migrationFiles } from '../src/db/migrationRunner';
import { SchemaBuilder } from '../src/db/schemaBuilder';

void test('libSQL applies the 13 production migrations with SQLite-compatible schema and indexes', async () => {
  const { createClient } = await import('@libsql/client');
  const db = new LibsqlAdapter(createClient({ url: ':memory:' }), { ownsClient: true });
  try {
    await db.exec('PRAGMA foreign_keys=ON');
    const runner = new MigrationRunner(db);
    const before = await runner.inspectSource();
    assert.equal(before.initialized, false);
    assert.equal(before.migrationTable, false);
    assert.equal(before.total, 13);
    assert.equal(migrationFiles().length, 13);
    const migrated = await runner.migrate();
    assert.equal(migrated.ran.length, 13);
    const after = await runner.inspectSource();
    assert.equal(after.initialized, true);
    assert.equal(after.pending.length, 0);
    assert.equal((await runner.migrate()).ran.length, 0);
    for (const table of [
      'users',
      'system_settings',
      'workers',
      'worker_enrollment_tokens',
      'worker_profiles',
      'mcp_oauth_clients',
      'mcp_oauth_authorization_codes',
      'mcp_oauth_access_tokens',
      'mcp_oauth_refresh_tokens',
      'mcp_request_audit',
    ]) {
      assert.equal(await new SchemaBuilder(db).hasTable(table), true, table);
    }
    const indexes = await db.queryAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mcp_oauth_clients'",
    );
    assert.ok(indexes.some((row) => row.name === 'idx_mcp_clients_owner_user'));
  } finally {
    await db.close();
  }
});

void test('libSQL OAuth and Worker owners retain foreign key isolation', async () => {
  const { createClient } = await import('@libsql/client');
  const db = new LibsqlAdapter(createClient({ url: ':memory:' }), { ownsClient: true });
  try {
    await db.exec('PRAGMA foreign_keys=ON');
    await new MigrationRunner(db).migrate();
    const enabled = await db.queryOne<{ foreign_keys: number }>('PRAGMA foreign_keys');
    assert.equal(enabled?.foreign_keys, 1);
    await db.execute(
      'INSERT INTO users (id, username, display_name, password_hash, principal_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['user-1', 'alice', 'Alice', 'hashed', 'principal-alice', 'profile-alice', 'now', 'now'],
    );
    const clientFields = [
      'client-a',
      'client-id-a',
      'hashed',
      'Test Client',
      'principal-alice',
      'profile-alice',
      '[]',
      '[]',
      'now',
      'now',
      'user-1',
    ];
    await db.execute(
      'INSERT INTO mcp_oauth_clients (id, client_id, client_secret_hash, display_name, principal_id, profile_id, redirect_uris_json, allowed_scopes_json, created_at, updated_at, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      clientFields,
    );
    await assert.rejects(() =>
      db.execute(
        'INSERT INTO mcp_oauth_clients (id, client_id, client_secret_hash, display_name, principal_id, profile_id, redirect_uris_json, allowed_scopes_json, created_at, updated_at, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['client-b', 'client-id-b', ...clientFields.slice(2, 10), 'unknown-user'],
      ),
    );
    const clients = await db.queryAll<{ id: string; owner_user_id: string }>(
      'SELECT id, owner_user_id FROM mcp_oauth_clients',
    );
    assert.deepEqual(clients, [{ id: 'client-a', owner_user_id: 'user-1' }]);
    await db.execute('DELETE FROM users WHERE id = ?', ['user-1']);
    assert.equal(
      (await db.queryAll('SELECT id FROM mcp_oauth_clients WHERE owner_user_id = ?', ['user-1']))
        .length,
      0,
    );
  } finally {
    await db.close();
  }
});

void test('libSQL rollback and transactional DDL are reversible', async () => {
  const { createClient } = await import('@libsql/client');
  const db = new LibsqlAdapter(createClient({ url: ':memory:' }), { ownsClient: true });
  try {
    const runner = new MigrationRunner(db);
    await runner.migrate();
    const rollback = await runner.rollback({ steps: 1 });
    assert.equal(rollback.rolledBack.length, 1);
    assert.equal((await runner.inspectSource()).initialized, false);
    assert.equal((await runner.migrate()).ran.length, 1);
    assert.equal((await runner.inspectSource()).initialized, true);

    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await new SchemaBuilder(tx).createTable('rolled_back', (table) => {
            table.string('name').primary();
          });
          throw new Error('abort migration');
        }),
      /abort migration/,
    );
    assert.equal(await new SchemaBuilder(db).hasTable('rolled_back'), false);
  } finally {
    await db.close();
  }
});

void test('two libSQL database clients can initialize a shared database without duplicate migrations', async () => {
  const { createClient } = await import('@libsql/client');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mcp_worker_libsql_init_'));
  const dbPath = path.join(directory, 'fresh.sqlite');
  const first = new LibsqlAdapter(createClient({ url: `file:${dbPath}` }), {
    ownsClient: true,
  });
  const second = new LibsqlAdapter(createClient({ url: `file:${dbPath}` }), {
    ownsClient: true,
  });
  try {
    // Disposable on-disk SQLite uses WAL, as recommended for multi-connection
    // access; the remote libSQL deployment must be validated separately.
    await first.exec('PRAGMA journal_mode=WAL');
    await first.exec('PRAGMA busy_timeout=5000');
    await second.exec('PRAGMA busy_timeout=5000');
    const migrations = await Promise.all([
      new MigrationRunner(first).migrate(),
      new MigrationRunner(second).migrate(),
    ]);
    assert.equal(
      migrations.reduce((sum, item) => sum + item.ran.length, 0),
      13,
    );
    assert.equal((await new MigrationRunner(first).executed()).length, 13);
    assert.equal((await new MigrationRunner(second).inspectSource()).initialized, true);
  } finally {
    await first.close();
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
