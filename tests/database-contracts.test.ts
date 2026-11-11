import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/db/adapters/sqliteAdapter';
import { normalizeMysqlError } from '../src/db/adapters/mysqlAdapter';
import { getDb } from '../src/db/connection';
import path from 'node:path';

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
void test('MySQL normalization retains stable error codes', () => {
  assert.deepEqual(normalizeMysqlError({ code: 'ER_DUP_ENTRY' }), { code: 'DB_UNIQUE_CONSTRAINT' });
  assert.deepEqual(normalizeMysqlError({ message: 'Queue limit reached.' }), {
    message: 'Queue limit reached.',
    code: 'MYSQL_POOL_BUSY',
    status: 503,
  });
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
