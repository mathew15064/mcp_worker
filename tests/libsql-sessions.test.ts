import test from 'node:test';
import assert from 'node:assert/strict';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { LibsqlSessionStore } from '../src/db/libsqlSessionStore';
import type { SessionData } from 'express-session';

const SECRET = 'test-only-session-secret-very-long-and-stable-2026';

function safeRejection(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function get(store: LibsqlSessionStore, sid: string): Promise<SessionData | null | undefined> {
  return new Promise((resolve, reject) =>
    store.get(sid, (error, sess) => (error ? reject(safeRejection(error)) : resolve(sess))),
  );
}

function set(store: LibsqlSessionStore, sid: string, data: SessionData): Promise<void> {
  return new Promise((resolve, reject) =>
    store.set(sid, data, (error) => (error ? reject(safeRejection(error)) : resolve())),
  );
}

function touch(store: LibsqlSessionStore, sid: string, data: SessionData): Promise<void> {
  return new Promise((resolve, reject) =>
    store.touch(sid, data, (error) => (error ? reject(safeRejection(error)) : resolve())),
  );
}

function destroy(store: LibsqlSessionStore, sid: string): Promise<void> {
  return new Promise((resolve, reject) =>
    store.destroy(sid, (error) => (error ? reject(safeRejection(error)) : resolve())),
  );
}

const sessionValue = (userId: string): SessionData => ({
  cookie: { originalMaxAge: 60_000, maxAge: 60_000, secure: true, httpOnly: true, path: '/' },
  userId,
  role: 'admin',
  csrfToken: 'csrf-test-secret-do-not-store-plain',
  oauthOneTimeSecret: { clientId: 'client-a', clientSecret: 'secret-test-value' },
});

void test('encrypted Admin sessions survive reconnect and isolate multiple DB instances', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createClient } = await import('@libsql/client');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp_worker_sessions_'));
  const url = `file:${path.join(directory, 'sessions.sqlite')}`;
  const first = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  const second = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  try {
    const storeA = new LibsqlSessionStore({ adapter: first, secret: SECRET });
    const storeB = new LibsqlSessionStore({ adapter: second, secret: SECRET });
    await storeA.initialize();
    await storeB.initialize();
    await set(storeA, 'session-token-should-not-be-stored', sessionValue('alice'));
    const record = await second.queryOne<{ sid_hash: string; ciphertext: string }>(
      'SELECT sid_hash, ciphertext FROM admin_sessions',
    );
    assert.ok(record);
    assert.notEqual(record.sid_hash, 'session-token-should-not-be-stored');
    assert.doesNotMatch(record.ciphertext, /alice|secret-test-value|csrf-test-secret/);
    assert.equal((await get(storeB, 'session-token-should-not-be-stored'))?.userId, 'alice');
    storeA.close();
    await first.close();
    assert.equal((await get(storeB, 'session-token-should-not-be-stored'))?.userId, 'alice');
    await touch(storeB, 'session-token-should-not-be-stored', sessionValue('alice'));
    await destroy(storeB, 'session-token-should-not-be-stored');
    assert.equal(await get(storeB, 'session-token-should-not-be-stored'), null);
    // A touch after session destruction must not resurrect it.
    await touch(storeB, 'session-token-should-not-be-stored', sessionValue('alice'));
    assert.equal(await get(storeB, 'session-token-should-not-be-stored'), null);
  } finally {
    await first.close();
    await second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

void test('Admin session timeout, pruning and tamper fail closed', async () => {
  const { createClient } = await import('@libsql/client');
  const db = new LibsqlAdapter(createClient({ url: ':memory:' }), { ownsClient: true });
  let now = 100_000;
  const store = new LibsqlSessionStore({ adapter: db, secret: SECRET, now: () => now });
  try {
    await store.initialize();
    await set(store, 'expired', sessionValue('bob'));
    now += 60_001;
    assert.equal(await get(store, 'expired'), null);
    assert.equal(await store.pruneExpired(), 1);
    assert.equal(await store.pruneExpired(), 0);

    await set(store, 'tampered', sessionValue('carol'));
    await db.execute('UPDATE admin_sessions SET ciphertext = ? WHERE sid_hash <> ?', [
      'v1.AAAAAAAA.bad.bad',
      'does-not-exist',
    ]);
    await assert.rejects(() => get(store, 'tampered'));
    const wrongSecret = new LibsqlSessionStore({
      adapter: db,
      secret: 'another-secure-secret-for-this-instance-2026',
    });
    await wrongSecret.initialize();
    assert.equal(await get(wrongSecret, 'tampered'), null);
  } finally {
    await db.close();
  }
});

void test('Admin session store requires a stable strong secret and explicit initialization', async () => {
  const { createClient } = await import('@libsql/client');
  const db = new LibsqlAdapter(createClient({ url: ':memory:' }), { ownsClient: true });
  try {
    assert.throws(
      () => new LibsqlSessionStore({ adapter: db, secret: 'short' }),
      /stable SESSION_SECRET/,
    );
    const uninitialized = new LibsqlSessionStore({ adapter: db, secret: SECRET });
    await assert.rejects(() => get(uninitialized, 'id'), /initialize must complete/);
  } finally {
    await db.close();
  }
});
