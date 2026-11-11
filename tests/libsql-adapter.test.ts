import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LibsqlAdapter,
  normalizeLibsqlError,
  validateRemoteLibsqlConfig,
} from '../src/db/adapters/libsqlAdapter';
import type { DatabaseAdapter } from '../src/db/contracts';

void test('libSQL remote factory rejects file, insecure URL, query credentials and missing token', async () => {
  const invalid = [
    { url: 'file:local.db', authToken: 'secret' },
    { url: ':memory:', authToken: 'secret' },
    { url: 'http://example.test', authToken: 'secret' },
    { url: 'https://user:secret@example.test', authToken: 'secret' },
    { url: 'https://example.test/?authToken=secret', authToken: 'secret' },
    { url: 'https://example.test', authToken: '' },
  ];
  for (const config of invalid) {
    assert.throws(() => validateRemoteLibsqlConfig(config));
    await assert.rejects(() => LibsqlAdapter.createRemote(config));
  }
  assert.deepEqual(
    validateRemoteLibsqlConfig({
      url: 'libsql://db.example.test',
      authToken: 'test-only-token',
    }),
    { url: 'libsql://db.example.test', authToken: 'test-only-token' },
  );
});

void test('libSQL implements typed query, queryAll, bind and affected-row semantics', async () => {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: ':memory:' });
  const db: DatabaseAdapter = new LibsqlAdapter(client, { ownsClient: true });
  try {
    assert.equal(db.kind, 'libsql');
    assert.equal(await db.ping(), true);
    await db.exec(
      'CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT NOT NULL, flag INTEGER, at TEXT, data BLOB)',
    );
    assert.equal(await db.queryOne('SELECT * FROM items'), null);
    const createdAt = new Date('2026-11-11T01:02:03.000Z');
    const inserted = await db.execute(
      'INSERT INTO items (text, flag, at, data) VALUES (?, ?, ?, ?)',
      ["harmless '); DROP TABLE items;--", true, createdAt, Buffer.from('blob')],
    );
    assert.equal(inserted.changes, 1);
    assert.equal(inserted.insertId, 1n);
    const row = await db.queryOne<{
      text: string;
      flag: number;
      at: string;
      data: Buffer;
    }>('SELECT text, flag, at, data FROM items WHERE id = ?', [1]);
    assert.equal(row?.text, "harmless '); DROP TABLE items;--");
    assert.equal(row.flag, 1);
    assert.equal(row.at, createdAt.toISOString());
    assert.equal(Buffer.from(row.data).toString(), 'blob');
    assert.equal((await db.queryAll('SELECT id FROM items')).length, 1);
    const updated = await db.execute('UPDATE items SET flag = ? WHERE id = ?', [false, 1]);
    assert.equal(updated.changes, 1);
    await assert.rejects(() => db.execute('INSERT INTO items (text) VALUES (?)', [Number.NaN]));
    await assert.rejects(() =>
      db.execute('INSERT INTO items (text) VALUES (?)', [new Date('bad')]),
    );
  } finally {
    await db.close();
  }
});

void test('libSQL commits interactive transactions and rolls back failed callbacks', async () => {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: ':memory:' });
  const db = new LibsqlAdapter(client, { ownsClient: true });
  try {
    await db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    const result = await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO jobs (id, state) VALUES (?, ?)', ['one', 'queued']);
      assert.equal((await tx.queryAll('SELECT id FROM jobs')).length, 1);
      await assert.rejects(() => tx.transaction(() => Promise.resolve()), /Nested/);
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.equal((await db.queryAll('SELECT id FROM jobs')).length, 1);
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await tx.execute('INSERT INTO jobs (id, state) VALUES (?, ?)', ['two', 'running']);
          throw new Error('simulate failure');
        }),
      /simulate failure/,
    );
    assert.deepEqual(
      (await db.queryAll<{ id: string }>('SELECT id FROM jobs')).map((row) => row.id),
      ['one'],
    );
  } finally {
    await db.close();
  }
});

void test('libSQL normalizes duplicate keys with existing repository error code', async () => {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: ':memory:' });
  const db = new LibsqlAdapter(client, { ownsClient: true });
  try {
    await db.exec('CREATE TABLE unique_names (name TEXT PRIMARY KEY)');
    await db.execute('INSERT INTO unique_names (name) VALUES (?)', ['first']);
    await assert.rejects(
      () => db.execute('INSERT INTO unique_names (name) VALUES (?)', ['first']),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'DB_UNIQUE_CONSTRAINT',
    );
    const busy = { code: 'SQLITE_BUSY', status: 0 };
    assert.equal(normalizeLibsqlError(busy), busy);
    assert.deepEqual(busy, { code: 'LIBSQL_BUSY', status: 503 });
  } finally {
    await db.close();
  }
});

void test('libSQL adapter sharing a provided client does not own its lifecycle', async () => {
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: ':memory:' });
  const db = new LibsqlAdapter(client);
  await db.close();
  assert.equal(await db.ping(), true);
  client.close();
});
