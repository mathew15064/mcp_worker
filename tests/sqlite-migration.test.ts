import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations';
import databaseManager from '../src/db/databaseManager';
import { closeDb } from '../src/db/connection';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-worker-db-migration-'));
  const saved = {
    DATABASE_PATH: process.env.DATABASE_PATH,
    BOOTSTRAP_CONFIG_PATH: process.env.BOOTSTRAP_CONFIG_PATH,
  };
  process.env.DATABASE_PATH = path.join(root, 'mcp_worker.sqlite');
  process.env.BOOTSTRAP_CONFIG_PATH = path.join(root, 'bootstrap-config.json');
  databaseManager.resetForTests();
  return {
    root,
    close: async () => {
      await databaseManager.close();
      closeDb();
      databaseManager.resetForTests();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

void test('standalone startup renames a legacy schema ledger transactionally without losing rows', async () => {
  const f = fixture();
  try {
    const db = new Database(process.env.DATABASE_PATH);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.exec(
      'CREATE TABLE railway_schema_versions (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO railway_schema_versions VALUES (?, ?)').run(
      '2026-11-12-initial',
      '2026-11-12T00:00:00Z',
    );
    db.prepare('INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,?)').run(
      'recovery.marker',
      'preserved',
      '2026-11-12T00:00:00Z',
    );
    db.close();
    assert.equal((await databaseManager.initialize()).state, 'READY');
    const verify = new Database(process.env.DATABASE_PATH, { readonly: true });
    assert.equal(
      (
        verify.prepare('SELECT value FROM system_settings WHERE key=?').get('recovery.marker') as {
          value: string;
        }
      ).value,
      'preserved',
    );
    assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE name='schema_versions'").get());
    assert.equal(
      verify.prepare("SELECT name FROM sqlite_master WHERE name='railway_schema_versions'").get(),
      undefined,
    );
    verify.close();
  } finally {
    await f.close();
  }
});

void test('fresh startup refuses a renamed SQLite path when previous database still exists', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'bot_report.sqlite'), 'precious old database', {
      mode: 0o600,
    });
    await assert.rejects(databaseManager.initialize(), /Legacy SQLite filename found/);
    assert.equal(fs.existsSync(path.join(f.root, 'mcp_worker.sqlite')), false);
  } finally {
    await f.close();
  }
});

void test('explicit offline filename migration copies SQLite safely and refuses overwrite', async () => {
  const f = fixture();
  try {
    const sourcePath = path.join(f.root, 'bot_report.sqlite');
    const db = new Database(sourcePath);
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.exec(
      'CREATE TABLE railway_schema_versions (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO railway_schema_versions VALUES (?, ?)').run(
      '2026-11-12-initial',
      '2026-11-12T00:00:00Z',
    );
    db.close();
    const script = path.join(process.cwd(), 'dist/scripts/migrate-db-filename.cjs');
    const env = { ...process.env, MCP_WORKER_DATA_DIR: f.root };
    const first = spawnSync(process.execPath, [script, '--offline'], { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(fs.existsSync(sourcePath), 'source database must not be deleted');
    const output = path.join(f.root, 'mcp_worker.sqlite');
    const saved = new Database(output, { readonly: true });
    assert.equal(saved.pragma('integrity_check', { simple: true }), 'ok');
    saved.close();
    const repeated = spawnSync(process.execPath, [script, '--offline'], { env, encoding: 'utf8' });
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /refusing overwrite/);
    assert.equal((await databaseManager.initialize()).state, 'READY');
  } finally {
    await f.close();
  }
});
