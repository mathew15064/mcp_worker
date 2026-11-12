import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import session, { type SessionData } from 'express-session';
import databaseManager from '../src/db/databaseManager';
import { closeDb, getDb } from '../src/db/connection';
import SqliteSessionStore from '../src/db/sessionStore';
import { decryptString, encryptString, readKey } from '../src/services/applicationKeyService';

const envKeys = [
  'MCP_PLATFORM',
  'MCP_SETUP_SECRET',
  'DATABASE_PATH',
  'RAILWAY_VOLUME_MOUNT_PATH',
  'NODE_ENV',
] as const;

async function withDisposableVolume(
  run: (volume: { root: string; dbPath: string }) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-railway-security-'));
  const dbPath = path.join(root, 'bot_report.sqlite');
  const previous = new Map(envKeys.map((name) => [name, process.env[name]]));
  process.env.MCP_PLATFORM = 'railway';
  process.env.MCP_SETUP_SECRET = crypto.randomBytes(32).toString('base64url');
  process.env.DATABASE_PATH = dbPath;
  process.env.RAILWAY_VOLUME_MOUNT_PATH = root;
  process.env.NODE_ENV = 'test';
  databaseManager.resetForTests();
  closeDb();
  try {
    await run({ root, dbPath });
  } finally {
    await databaseManager.close();
    closeDb();
    databaseManager.resetForTests();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function saveSession(store: SqliteSessionStore, sid: string, data: SessionData) {
  return new Promise<void>((resolve, reject) => {
    store.set(sid, data, (error) => (error ? reject(error) : resolve()));
  });
}
function readSession(store: SqliteSessionStore, sid: string) {
  return new Promise<SessionData | null>((resolve, reject) => {
    store.get(sid, (error, data) => (error ? reject(error) : resolve(data || null)));
  });
}
function destroySession(store: SqliteSessionStore, sid: string) {
  return new Promise<void>((resolve, reject) => {
    store.destroy(sid, (error) => (error ? reject(error) : resolve()));
  });
}

void test('fresh schema, WAL, online backup and offline restore are consistent', async () => {
  await withDisposableVolume(async ({ root }) => {
    await databaseManager.initialize();
    assert.equal(databaseManager.isRailwaySqliteReady(), true);
    const db = getDb();
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.prepare('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'backup.marker',
      'committed-before-backup',
      new Date().toISOString(),
    );
    const snapshot = path.join(root, 'online-backup.sqlite');
    await db.backup(snapshot);
    const restore = path.join(root, 'offline-restored.sqlite');
    // Copy only the completed, closed backup file, never an active WAL database.
    fs.copyFileSync(snapshot, restore);
    const restored = new Database(restore, { readonly: true, fileMustExist: true });
    try {
      assert.equal(restored.pragma('quick_check', { simple: true }), 'ok');
      assert.equal(
        (
          restored
            .prepare('SELECT value FROM system_settings WHERE key = ?')
            .get('backup.marker') as { value: string }
        ).value,
        'committed-before-backup',
      );
      assert.equal(
        (
          restored
            .prepare('SELECT COUNT(*) AS count FROM railway_schema_versions')
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      restored.close();
    }
    await databaseManager.close();
    closeDb();
    databaseManager.resetForTests();
    await databaseManager.initialize();
    assert.equal(databaseManager.isRailwaySqliteReady(), true);
    assert.equal(
      (
        getDb()
          .prepare('SELECT value FROM system_settings WHERE key = ?')
          .get('backup.marker') as { value: string }
      ).value,
      'committed-before-backup',
    );
  });
});

void test('legacy SQLite upgrade preserves rows and runs idempotently', async () => {
  await withDisposableVolume(async ({ dbPath }) => {
    const legacy = new Database(dbPath);
    legacy.exec(
      [
        'CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,',
        'password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL,',
        'updated_at TEXT NOT NULL);',
        "INSERT INTO users VALUES ('legacy-user', 'legacy', 'existing-hash', 'user', 'before', 'before');",
        'CREATE TABLE mcp_oauth_clients (id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE,',
        'client_secret_hash TEXT NOT NULL, display_name TEXT NOT NULL, principal_id TEXT NOT NULL,',
        'redirect_uris_json TEXT NOT NULL, allowed_scopes_json TEXT NOT NULL,',
        'status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
        "INSERT INTO mcp_oauth_clients VALUES ('legacy-client', 'old-client', 'hash', 'legacy',",
        "'principal:legacy', '[]', '[]', 'active', 'before', 'before');",
      ].join('\n'),
    );
    legacy.close();
    for (let run = 0; run < 2; run++) {
      await databaseManager.initialize();
      assert.equal(databaseManager.isRailwaySqliteReady(), true);
      const db = getDb();
      const user = db
        .prepare('SELECT username, session_version FROM users WHERE id = ?')
        .get('legacy-user') as { username: string; session_version: number };
      assert.deepEqual(user, { username: 'legacy', session_version: 1 });
      const client = db
        .prepare('SELECT client_id, profile_id, owner_user_id FROM mcp_oauth_clients WHERE id = ?')
        .get('legacy-client') as {
        client_id: string;
        profile_id: string;
        owner_user_id: string | null;
      };
      assert.deepEqual(client, {
        client_id: 'old-client',
        profile_id: 'legacy_profile',
        owner_user_id: null,
      });
      assert.equal(
        (
          db
            .prepare('SELECT COUNT(*) AS count FROM railway_schema_versions')
            .get() as { count: number }
        ).count,
        1,
      );
      assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
      await databaseManager.close();
      closeDb();
      databaseManager.resetForTests();
    }
  });
});

void test('unknown schema versions refuse startup without deleting data', async () => {
  await withDisposableVolume(async ({ dbPath }) => {
    await databaseManager.initialize();
    const db = getDb();
    db.prepare('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'keep.me',
      'valuable',
      new Date().toISOString(),
    );
    db.prepare('INSERT INTO railway_schema_versions (version, applied_at) VALUES (?, ?)').run(
      '2099-unknown',
      new Date().toISOString(),
    );
    await databaseManager.close();
    closeDb();
    databaseManager.resetForTests();
    await assert.rejects(() => databaseManager.initialize(), /Unsupported Railway SQLite schema/);
    assert.equal(databaseManager.getAdapter(), null);
    closeDb();
    const readonly = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(
        (
          readonly
            .prepare('SELECT value FROM system_settings WHERE key = ?')
            .get('keep.me') as { value: string }
        ).value,
        'valuable',
      );
      assert.equal(
        (
          readonly
            .prepare('SELECT COUNT(*) AS count FROM railway_schema_versions')
            .get() as { count: number }
        ).count,
        2,
      );
    } finally {
      readonly.close();
    }
  });
});

void test('malformed schema and corrupt database refuse readiness', async () => {
  await withDisposableVolume(async ({ dbPath }) => {
    const malformed = new Database(dbPath);
    malformed.exec('CREATE TABLE sessions (sid TEXT PRIMARY KEY)');
    malformed.close();
    await assert.rejects(() => databaseManager.initialize(), /Incompatible Railway SQLite table/);
    assert.equal(databaseManager.getAdapter(), null);
    closeDb();
  });
  await withDisposableVolume(async ({ dbPath }) => {
    const corrupt = Buffer.from('this is not a SQLite database');
    fs.writeFileSync(dbPath, corrupt);
    await assert.rejects(() => databaseManager.initialize());
    assert.deepEqual(fs.readFileSync(dbPath), corrupt);
  });
});

void test('symlinks, path mismatch and non-writable volumes fail closed', async () => {
  await withDisposableVolume(async ({ root, dbPath }) => {
    fs.symlinkSync(path.join(root, 'external.sqlite'), dbPath);
    await assert.rejects(() => databaseManager.initialize(), /regular files/);
    fs.unlinkSync(dbPath);
    databaseManager.resetForTests();
    fs.symlinkSync(path.join(root, 'outside-wal'), dbPath + '-wal');
    await assert.rejects(() => databaseManager.initialize(), /regular files/);
    fs.unlinkSync(dbPath + '-wal');
    databaseManager.resetForTests();
    process.env.DATABASE_PATH = path.join(root, 'nested', 'unsafe.sqlite');
    await assert.rejects(() => databaseManager.initialize(), /inside the Railway volume/);
    databaseManager.resetForTests();
    process.env.DATABASE_PATH = dbPath;
    if (process.getuid?.() !== 0) {
      fs.chmodSync(root, 0o500);
      await assert.rejects(() => databaseManager.initialize());
      databaseManager.resetForTests();
      fs.chmodSync(root, 0o700);
    }
  });
});

void test('session expiration, logout revocation and admin credential rotation', async () => {
  await withDisposableVolume(async () => {
    await databaseManager.initialize();
    const db = getDb();
    const store = new SqliteSessionStore({ db });
    try {
      const data: SessionData = { cookie: new session.Cookie({ maxAge: 60_000 }) };
      await saveSession(store, 'ordinary', data);
      assert.ok(await readSession(store, 'ordinary'));
      db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(
        Date.now() - 1000,
        'ordinary',
      );
      assert.equal(await readSession(store, 'ordinary'), null);
      await saveSession(store, 'logout', data);
      await destroySession(store, 'logout');
      assert.equal(await readSession(store, 'logout'), null);

      const adminData: SessionData = {
        cookie: new session.Cookie({ maxAge: 60_000 }),
        userId: 'env-admin',
        role: 'admin',
        authSource: 'railway',
      };
      const firstHash = bcrypt.hashSync('first-private-password', 10);
      db.prepare('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        'bootstrap.admin_password_hash',
        firstHash,
        new Date().toISOString(),
      );
      await saveSession(store, 'admin', adminData);
      assert.ok(await readSession(store, 'admin'));
      const changedHash = bcrypt.hashSync('another-private-password', 10);
      db.prepare('UPDATE system_settings SET value = ? WHERE key = ?').run(
        changedHash,
        'bootstrap.admin_password_hash',
      );
      assert.equal(await readSession(store, 'admin'), null);
      assert.equal(
        (
          db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sid = ?').get('admin') as {
            count: number;
          }
        ).count,
        0,
      );
    } finally {
      store.close();
    }
  });
});

void test('encryption keys survive restart but isolate independent instances and AAD', async () => {
  await withDisposableVolume(async () => {
    await databaseManager.initialize();
    const originalSecret = process.env.MCP_SETUP_SECRET;
    const initialKey = readKey();
    const envelope = encryptString('only instance A can decrypt', 'instance:a');
    await databaseManager.close();
    closeDb();
    databaseManager.resetForTests();
    await databaseManager.initialize();
    assert.deepEqual(readKey(), initialKey);
    assert.equal(decryptString(envelope, 'instance:a'), 'only instance A can decrypt');
    assert.throws(() => decryptString(envelope, 'instance:b'), /could not be decrypted/);
    process.env.MCP_SETUP_SECRET = crypto.randomBytes(32).toString('base64url');
    assert.notDeepEqual(readKey(), initialKey);
    assert.throws(() => decryptString(envelope, 'instance:a'), /could not be decrypted/);
    process.env.MCP_SETUP_SECRET = originalSecret;
    assert.equal(decryptString(envelope, 'instance:a'), 'only instance A can decrypt');
  });
});
