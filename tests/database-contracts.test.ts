import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/db/adapters/sqliteAdapter';
import { getDb } from '../src/db/connection';
import path from 'node:path';
import fs from 'node:fs';
import { runMigrations } from '../src/db/migrations';
import { assertRailwaySqliteSchema } from '../src/db/sqliteSchemaValidation';

void test('typed SQLite adapter commits, rolls back and serializes transactions', async () => {
  const raw = new Database(':memory:');
  const db = new SqliteAdapter(raw);
  try {
    await db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)');
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO records VALUES (?, ?)', [1, 'committed']);
    });
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute('INSERT INTO records VALUES (?, ?)', [2, 'rollback']);
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.deepEqual(await db.queryAll<{ id: number; value: string }>('SELECT * FROM records'), [
      { id: 1, value: 'committed' },
    ]);
  } finally {
    raw.close();
  }
});
void test('OAuth revoke UPDATE is atomically scoped to the authenticated client', async () => {
  const raw = new Database(':memory:');
  const db = new SqliteAdapter(raw);
  try {
    // A minimal disposable schema verifies the actual SQL authorization guard
    // without depending on the user's database or an external MySQL service.
    await db.exec(
      'CREATE TABLE mcp_oauth_access_tokens (token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, revoked_at TEXT)',
    );
    await db.exec(
      'CREATE TABLE mcp_oauth_refresh_tokens (token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, revoked_at TEXT)',
    );
    await db.execute('INSERT INTO mcp_oauth_access_tokens (token_hash, client_id) VALUES (?, ?)', [
      'secret-access-b',
      'client-b',
    ]);
    await db.execute('INSERT INTO mcp_oauth_refresh_tokens (token_hash, client_id) VALUES (?, ?)', [
      'secret-refresh-b',
      'client-b',
    ]);
    const { McpOAuthRepository } = (await import('../src/repositories/mcpOAuthRepository.js'))
      .default;
    const repository = new McpOAuthRepository(db);

    await repository.revokeAccessTokenForClient('secret-access-b', 'client-a');
    await repository.revokeRefreshTokenForClient('secret-refresh-b', 'client-a');

    const accessBefore = await db.queryOne<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM mcp_oauth_access_tokens WHERE token_hash = ?',
      ['secret-access-b'],
    );
    const refreshBefore = await db.queryOne<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM mcp_oauth_refresh_tokens WHERE token_hash = ?',
      ['secret-refresh-b'],
    );
    assert.equal(accessBefore?.revoked_at, null, 'Client A must not revoke Client B access');
    assert.equal(refreshBefore?.revoked_at, null, 'Client A must not revoke Client B refresh');

    await repository.revokeAccessTokenForClient('secret-access-b', 'client-b');
    await repository.revokeRefreshTokenForClient('secret-refresh-b', 'client-b');
    const accessAfter = await db.queryOne<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM mcp_oauth_access_tokens WHERE token_hash = ?',
      ['secret-access-b'],
    );
    const refreshAfter = await db.queryOne<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM mcp_oauth_refresh_tokens WHERE token_hash = ?',
      ['secret-refresh-b'],
    );
    assert.ok(accessAfter?.revoked_at, 'Owner client must be able to revoke its access token');
    assert.ok(refreshAfter?.revoked_at, 'Owner client must be able to revoke its refresh token');
  } finally {
    raw.close();
  }
});

void test('Railway SQLite readiness rejects missing indexes, foreign keys, and partial legacy tables', () => {
  const valid = new Database(':memory:');
  const withoutFk = new Database(':memory:');
  const partial = new Database(':memory:');
  try {
    valid.pragma('foreign_keys = ON');
    runMigrations(valid);
    assert.doesNotThrow(() => assertRailwaySqliteSchema(valid));
    valid.exec('DROP INDEX idx_mcp_access_tokens_client');
    assert.throws(
      () => assertRailwaySqliteSchema(valid),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'RAILWAY_SCHEMA_INCOMPATIBLE' &&
        /index/.test(error.message),
    );

    // Same tables/columns but a silently omitted ownership FK cannot be READY.
    withoutFk.pragma('foreign_keys = ON');
    const canonical = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    assert.ok(canonical.includes('owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,'));
    withoutFk.exec(
      canonical.replace(
        'owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,',
        'owner_user_id TEXT,',
      ),
    );
    runMigrations(withoutFk);
    assert.throws(() => assertRailwaySqliteSchema(withoutFk), /foreign key/);

    partial.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    runMigrations(partial);
    assert.throws(() => assertRailwaySqliteSchema(partial), /column/);
  } finally {
    valid.close();
    withoutFk.close();
    partial.close();
  }
});

void test('Railway SQLite validation rejects orphaned ownership references', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO mcp_oauth_clients
       (id,client_id,client_secret_hash,display_name,principal_id,profile_id,
        owner_user_id,redirect_uris_json,allowed_scopes_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'orphan',
      'orphan-client',
      'hashed',
      'Orphan',
      'principal:orphan',
      'profile:orphan',
      'no-such-user',
      '[]',
      '["bot_report.read"]',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.pragma('foreign_keys = ON');
    assert.throws(() => assertRailwaySqliteSchema(db), /orphaned foreign key row/);
  } finally {
    db.close();
  }
});
void test('compiled SQLite guard refuses project production database in test mode', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    assert.throws(
      () => getDb(path.resolve(__dirname, '../../data/bot_report.sqlite')),
      /DATA_SAFETY_VIOLATION/,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
