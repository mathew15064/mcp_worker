import fs from 'node:fs';
import path from 'node:path';
import config from '../config/env';
import { getDb, closeDb } from './connection';
import { SqliteAdapter } from './adapters/sqliteAdapter';
import type { DatabaseAdapter } from './contracts';
import type Database from 'better-sqlite3';
import { runMigrations } from './migrations';
import { assertSqliteSchema } from './sqliteSchemaValidation';

const STATES = Object.freeze({
  UNCONFIGURED: 'UNCONFIGURED',
  TEST_SQLITE: 'TEST_SQLITE',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
} as const);
type State = (typeof STATES)[keyof typeof STATES];
const SCHEMA_VERSION = '2026-11-12-initial';

class DatabaseManager {
  state: State = STATES.UNCONFIGURED;
  adapter: DatabaseAdapter | null = null;
  sourceInfo: { initialized: boolean; total: number; ran: number; pending: string[] } | null = null;
  lastError: { code: string; message: string } | null = null;
  initialized = false;

  databaseExists() {
    try {
      return fs.statSync(config.DATABASE_PATH).size > 0;
    } catch {
      return false;
    }
  }

  async initialize() {
    if (this.initialized) return this.status();
    this.initialized = true;
    // Refuse silent reuse of a pre-SQLite installation's configuration.
    // A fresh development installation must explicitly use a new project/volume.
    const oldBootstrap = path.resolve(
      process.cwd(),
      process.env.BOOTSTRAP_CONFIG_PATH || 'data/bootstrap-config.json',
    );
    if (fs.existsSync(oldBootstrap)) {
      throw Object.assign(
        new Error(
          'Obsolete database bootstrap detected; fresh SQLite setup requires a clean data directory.',
        ),
        {
          code: 'OBSOLETE_BOOTSTRAP_REFUSED',
        },
      );
    }
    if (
      path.basename(config.DATABASE_PATH) === 'mcp_worker.sqlite' &&
      !fs.existsSync(config.DATABASE_PATH) &&
      fs.existsSync(path.join(path.dirname(config.DATABASE_PATH), 'bot_report.sqlite'))
    ) {
      throw Object.assign(new Error('Legacy SQLite filename found; manual migration required.'), {
        code: 'LEGACY_SQLITE_MIGRATION_REQUIRED',
      });
    }
    if (!fs.existsSync(config.DATABASE_PATH)) {
      this.state = STATES.UNCONFIGURED;
      return this.status();
    }
    const dbPath = config.DATABASE_PATH;
    const dir = path.dirname(dbPath);
    if (fs.realpathSync(dir) !== dir) {
      throw Object.assign(new Error('SQLite data directory must not be a symlink.'), {
        code: 'SQLITE_PATH_INVALID',
      });
    }
    for (const file of [dbPath, dbPath + '-wal', dbPath + '-shm', dbPath + '-journal']) {
      const entry = fs.lstatSync(file, { throwIfNoEntry: false });
      if (entry && (!entry.isFile() || entry.isSymbolicLink())) {
        throw Object.assign(new Error('SQLite database files must be regular files.'), {
          code: 'SQLITE_PATH_INVALID',
        });
      }
    }
    const state = this.activateSqlite();
    await this.adapter?.ping();
    return state;
  }

  private activateSqlite() {
    try {
      const db = getDb();
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
        throw Object.assign(new Error('SQLite integrity check failed.'), {
          code: 'SQLITE_INTEGRITY_FAILED',
        });
      }
      db.transaction(() => {
        // Preserve existing data during the one-time ledger rename.
        const oldLedger = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='railway_schema_versions'",
          )
          .get();
        const newLedger = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'")
          .get();
        if (oldLedger && newLedger)
          throw Object.assign(
            new Error('Ambiguous SQLite schema ledgers; manual recovery required.'),
            { code: 'SQLITE_SCHEMA_UNSUPPORTED' },
          );
        if (oldLedger) db.exec('ALTER TABLE railway_schema_versions RENAME TO schema_versions');
        if (oldLedger || newLedger) {
          const versions = db.prepare('SELECT version FROM schema_versions').all() as {
            version: string;
          }[];
          if (versions.length !== 1 || versions[0]?.version !== SCHEMA_VERSION) {
            throw Object.assign(new Error('Unsupported SQLite schema version.'), {
              code: 'SQLITE_SCHEMA_UNSUPPORTED',
            });
          }
        }
        runMigrations(db);
        assertSqliteSchema(db);
        db.exec(
          'CREATE TABLE IF NOT EXISTS schema_versions (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
        );
        db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(
          SCHEMA_VERSION,
          new Date().toISOString(),
        );
      })();
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
        throw Object.assign(new Error('SQLite integrity check failed.'), {
          code: 'SQLITE_INTEGRITY_FAILED',
        });
      }
      this.adapter = new SqliteAdapter(db);
      this.state = STATES.READY;
      this.lastError = null;
      this.sourceInfo = { initialized: true, total: 13, ran: 13, pending: [] };
      return this.status();
    } catch (error) {
      closeDb();
      this.adapter = null;
      this.state = STATES.DEGRADED;
      this.lastError = {
        code:
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'SQLITE_OPEN_FAILED',
        message: error instanceof Error ? error.message : 'SQLite initialization failed',
      };
      throw error;
    }
  }

  useSqliteForTests(db: Database.Database | null = null) {
    this.initialized = true;
    this.adapter = new SqliteAdapter(db || getDb());
    this.state = STATES.TEST_SQLITE;
    this.sourceInfo = { initialized: true, total: 0, ran: 0, pending: [] };
    this.lastError = null;
    return this.adapter;
  }

  getAdapter() {
    return this.adapter;
  }

  requireAdapter() {
    if (!this.adapter || !this.isOperational()) {
      throw Object.assign(new Error('SQLite database is unavailable.'), {
        code: 'DATABASE_UNAVAILABLE',
        status: 503,
      });
    }
    return this.adapter;
  }

  isOperational() {
    return !!this.adapter && (this.state === STATES.READY || this.state === STATES.TEST_SQLITE);
  }
  isSqlReady() {
    return this.state === STATES.READY && this.adapter?.kind === 'sqlite';
  }
  isSetupOnly() {
    return !this.isOperational();
  }

  status() {
    return {
      state: this.state,
      engine: this.isOperational() ? 'sqlite' : null,
      source: this.sourceInfo
        ? { ...this.sourceInfo, pending: [...this.sourceInfo.pending] }
        : null,
      databaseExists: this.databaseExists(),
      operational: this.isOperational(),
      setupOnly: this.isSetupOnly(),
      lastError: this.lastError,
    };
  }

  async close() {
    await this.adapter?.close();
    this.adapter = null;
    closeDb();
  }

  resetForTests() {
    this.adapter = null;
    this.state = STATES.UNCONFIGURED;
    this.sourceInfo = null;
    this.lastError = null;
    this.initialized = false;
  }
}

const instance = Object.assign(new DatabaseManager(), { DatabaseManager, STATES });
export = instance;
