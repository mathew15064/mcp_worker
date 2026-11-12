import fs from 'node:fs';
import path from 'node:path';
import config from '../config/env';
import bootstrapConfigStore from './bootstrapConfigStore';
import { getDb } from './connection';
import { SqliteAdapter } from './adapters/sqliteAdapter';
import { MysqlAdapter } from './adapters/mysqlAdapter';
import { PostgresAdapter } from './adapters/postgresAdapter';
import type { DatabaseAdapter, SqlRow } from './contracts';
import type Database from 'better-sqlite3';
import { MigrationRunner } from './migrationRunner';
import { runMigrations } from './migrations';
type MysqlInput = Parameters<typeof MysqlAdapter.create>[0];
type SourceInfo = Awaited<ReturnType<MigrationRunner['inspectSource']>>;
interface Candidate {
  adapter: MysqlAdapter | PostgresAdapter;
  info: SqlRow;
  source: SourceInfo;
  duration_ms: number;
}
interface Prepared extends Candidate {
  beforeSource: SourceInfo;
  migration: Awaited<ReturnType<MigrationRunner['migrate']>>;
}
function managedPostgresUrl() {
  if (process.env.MCP_PLATFORM !== 'vercel') return '';
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
}

function errorCode(error: unknown) {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null;
}

const STATES = Object.freeze({
  UNCONFIGURED: 'UNCONFIGURED',
  MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
  CONFIGURED: 'CONFIGURED',
  LEGACY_SQLITE: 'LEGACY_SQLITE', // test-only compatibility adapter
  READY: 'READY',
  DEGRADED: 'DEGRADED',
} as const);
type State = (typeof STATES)[keyof typeof STATES];

class DatabaseManager {
  state: State;
  adapter: DatabaseAdapter | null;
  mysqlInfo: SqlRow | null;
  sourceInfo: SourceInfo | null;
  lastError: { code: string; message: string } | null;
  lastTestAt: string | null;
  initialized: boolean;
  constructor() {
    this.state = STATES.UNCONFIGURED;
    this.adapter = null;
    this.mysqlInfo = null;
    this.sourceInfo = null;
    this.lastError = null;
    this.lastTestAt = null;
    this.initialized = false;
  }

  legacyAvailable() {
    try {
      const stat = fs.statSync(config.DATABASE_PATH);
      return stat.isFile() && stat.size > 0;
    } catch (_) {
      return false;
    }
  }

  async inspectMysql(input: MysqlInput) {
    const adapter = MysqlAdapter.create(input);
    try {
      const started = Date.now();
      await adapter.ping();
      const info = await adapter.serverInfo();
      const source = await new MigrationRunner(adapter).inspectSource();
      return { adapter, info, source, duration_ms: Date.now() - started };
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }

  async adoptInspected(candidate: Candidate) {
    const previous = this.adapter;
    this.mysqlInfo = candidate.info || null;
    this.sourceInfo = candidate.source || null;
    this.lastError = null;
    this.lastTestAt = new Date().toISOString();

    if (candidate.source?.initialized) {
      this.adapter = candidate.adapter;
      this.state = STATES.READY;
    } else {
      this.adapter = null;
      this.state = STATES.CONFIGURED;
      try {
        await candidate.adapter.close();
      } catch (_) {}
    }

    if (
      (previous?.kind === 'mysql' || previous?.kind === 'postgres') &&
      previous !== this.adapter &&
      previous !== candidate.adapter
    ) {
      try {
        await previous.close();
      } catch (_) {}
    }
    return this.status();
  }

  async initialize() {
    if (this.initialized) return this.status();
    this.initialized = true;

    if (process.env.MCP_PLATFORM === 'vercel') {
      return this.connectManagedPostgres();
    }
    if (process.env.MCP_PLATFORM === 'railway') {
      return this.connectRailwaySqlite();
    }
    if (bootstrapConfigStore.exists()) {
      return this.reconnect();
    }

    if (this.legacyAvailable()) {
      this.adapter = null;
      this.state = STATES.MIGRATION_REQUIRED;
      this.sourceInfo = null;
      this.lastError = null;
      return this.status();
    }

    this.state = STATES.UNCONFIGURED;
    this.adapter = null;
    this.sourceInfo = null;
    return this.status();
  }

  /**
   * Dedicated, single-replica Railway backend. Never use ephemeral container
   * storage: the platform volume must match the configured SQLite directory.
   * Schema changes are additive and idempotent via the existing SQLite schema
   * upgrade path, run atomically before accepting HTTP connections.
   */
  connectRailwaySqlite() {
    const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!volumePath || !path.isAbsolute(volumePath)) {
      throw Object.assign(new Error('Railway persistent volume is required.'), {
        code: 'RAILWAY_VOLUME_MISSING',
      });
    }
    const expected = path.dirname(config.DATABASE_PATH);
    if (fs.realpathSync(volumePath) !== fs.realpathSync(expected)) {
      throw Object.assign(new Error('SQLite database must be inside the Railway volume.'), {
        code: 'RAILWAY_VOLUME_PATH_MISMATCH',
      });
    }
    fs.accessSync(volumePath, fs.constants.R_OK | fs.constants.W_OK);
    // Never follow a database symlink out of the attached volume. The
    // directory is already canonicalized above, but the file also needs
    // verification before better-sqlite3 opens or creates it.
    if (
      fs.existsSync(config.DATABASE_PATH) &&
      fs.lstatSync(config.DATABASE_PATH).isSymbolicLink()
    ) {
      throw Object.assign(new Error('Railway SQLite database may not be a symlink.'), {
        code: 'RAILWAY_DB_SYMLINK_DENIED',
      });
    }
    const db = getDb();
    db.transaction(() => {
      runMigrations(db);
      // An explicit, durable first migration baseline. Future additive schema
      // revisions must add their own identifier in this ledger.
      db.exec(
        'CREATE TABLE IF NOT EXISTS railway_schema_versions (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
      );
      db.prepare(
        'INSERT OR IGNORE INTO railway_schema_versions (version, applied_at) VALUES (?, ?)',
      ).run('2026-11-12-initial', new Date().toISOString());
    })();
    const integrity = db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error('SQLite integrity check failed.');
    this.adapter = new SqliteAdapter(db);
    this.state = STATES.READY;
    this.initialized = true;
    this.lastError = null;
    this.sourceInfo = {
      initialized: true,
      migrationTable: false,
      total: 1,
      ran: 1,
      pending: [],
    };
    return this.status();
  }

  async connectManagedPostgres() {
    const url = managedPostgresUrl();
    this.initialized = true;
    if (!url) {
      this.adapter = null;
      this.state = STATES.UNCONFIGURED;
      this.lastError = {
        code: 'POSTGRES_MISSING',
        message: 'Connect Neon PostgreSQL in Vercel Storage.',
      };
      return this.status();
    }
    let adapter: PostgresAdapter | null = null;
    try {
      adapter = PostgresAdapter.create(url);
      await adapter.ping();
      const source = await new MigrationRunner(adapter).inspectSource();
      const info = await adapter.serverInfo();
      if (source.initialized) {
        this.adapter = adapter;
        this.state = STATES.READY;
      } else {
        await adapter.close();
        this.adapter = null;
        this.state = STATES.CONFIGURED;
      }
      this.mysqlInfo = info;
      this.sourceInfo = source;
      this.lastError = null;
      return this.status();
    } catch (error) {
      await adapter?.close().catch(() => {});
      this.adapter = null;
      this.sourceInfo = null;
      this.state = STATES.DEGRADED;
      this.lastError = {
        code: errorCode(error) || 'POSTGRES_CONNECT_FAILED',
        message: 'PostgreSQL unavailable; check the Vercel Storage connection.',
      };
      return this.status();
    }
  }

  async prepareManagedPostgresInitialization() {
    const url = managedPostgresUrl();
    if (!url)
      throw Object.assign(new Error('Neon PostgreSQL must be connected before setup.'), {
        code: 'POSTGRES_MISSING',
        status: 503,
      });
    const adapter = PostgresAdapter.create(url);
    try {
      await adapter.ping();
      const runner = new MigrationRunner(adapter);
      const beforeSource = await runner.inspectSource();
      const migration = await runner.migrate();
      const source = await runner.inspectSource();
      if (!source.initialized) throw new Error('PostgreSQL migration incomplete.');
      return {
        adapter,
        info: (await adapter.serverInfo()) || {},
        beforeSource,
        source,
        migration,
        duration_ms: 0,
      };
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }

  useLegacyForTests(db: Database.Database | null = null) {
    this.initialized = true;
    this.adapter = new SqliteAdapter(db || getDb());
    this.state = STATES.LEGACY_SQLITE;
    this.mysqlInfo = null;
    this.sourceInfo = { initialized: true, migrationTable: false, total: 0, ran: 0, pending: [] };
    this.lastError = null;
    return this.adapter;
  }

  getAdapter() {
    return this.adapter;
  }

  requireAdapter() {
    if (!this.adapter || !([STATES.READY, STATES.LEGACY_SQLITE] as State[]).includes(this.state)) {
      const messages: Partial<Record<State, string>> = {
        [STATES.DEGRADED]: 'MySQL is configured but unavailable.',
        [STATES.CONFIGURED]:
          'MySQL connection is saved but the mcp_worker source has not been initialized.',
        [STATES.MIGRATION_REQUIRED]: 'MySQL is not configured.',
        [STATES.UNCONFIGURED]: 'MySQL is not configured.',
      };
      const code =
        this.state === STATES.DEGRADED
          ? 'DATABASE_DEGRADED'
          : this.state === STATES.CONFIGURED
            ? 'DATABASE_SOURCE_UNINITIALIZED'
            : 'DATABASE_UNCONFIGURED';
      throw Object.assign(
        new Error(messages[this.state] || 'Application database is unavailable.'),
        { code, status: 503 },
      );
    }
    return this.adapter;
  }

  isOperational() {
    return (
      Boolean(this.adapter) &&
      ([STATES.READY, STATES.LEGACY_SQLITE] as State[]).includes(this.state)
    );
  }
  isMysqlReady() {
    return this.state === STATES.READY && this.adapter?.kind === 'mysql';
  }
  isManagedPostgresReady() {
    return this.state === STATES.READY && this.adapter?.kind === 'postgres';
  }
  isRailwaySqliteReady() {
    return (
      this.state === STATES.READY &&
      this.adapter?.kind === 'sqlite' &&
      process.env.MCP_PLATFORM === 'railway'
    );
  }
  isSqlReady() {
    return this.isMysqlReady() || this.isManagedPostgresReady() || this.isRailwaySqliteReady();
  }
  isSetupOnly() {
    return (
      [
        STATES.UNCONFIGURED,
        STATES.MIGRATION_REQUIRED,
        STATES.CONFIGURED,
        STATES.DEGRADED,
      ] as State[]
    ).includes(this.state);
  }

  async testMysql(input: MysqlInput) {
    const adapter = MysqlAdapter.create(input);
    const started = Date.now();
    try {
      await adapter.ping();
      const info = await adapter.serverInfo();
      this.lastTestAt = new Date().toISOString();
      return {
        ok: true,
        duration_ms: Date.now() - started,
        version: info.version || null,
        database: info.database_name || input.database || null,
      };
    } finally {
      await adapter.close();
    }
  }

  async saveMysqlConfig(input: MysqlInput) {
    bootstrapConfigStore.save(input);
    return this.reconnect();
  }

  async prepareSourceInitialization() {
    if (!bootstrapConfigStore.exists()) {
      const error = Object.assign(
        new Error('Save the MySQL connection before initializing the source.'),
        { code: 'DATABASE_UNCONFIGURED' },
      );
      throw error;
    }

    const input = bootstrapConfigStore.load();
    if (!input)
      throw Object.assign(new Error('Bootstrap database configuration is missing.'), {
        code: 'DATABASE_UNCONFIGURED',
      });
    const adapter = MysqlAdapter.create(input);
    try {
      const started = Date.now();
      await adapter.ping();
      const info = await adapter.serverInfo();
      const runner = new MigrationRunner(adapter);
      const beforeSource = await runner.inspectSource();
      const migration = await runner.migrate();
      const source = await runner.inspectSource();
      if (!source.initialized) {
        const error = Object.assign(
          new Error('mcp_worker source initialization did not complete.'),
          { code: 'DATABASE_SOURCE_UNINITIALIZED' },
        );
        throw error;
      }
      return { adapter, info, beforeSource, source, migration, duration_ms: Date.now() - started };
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }

  async activatePrepared(prepared: Prepared) {
    if (!prepared?.adapter || !prepared?.source?.initialized) {
      throw new Error('A fully initialized MySQL source is required before activation.');
    }
    const previous = this.adapter;
    this.adapter = prepared.adapter;
    this.state = STATES.READY;
    this.mysqlInfo = prepared.info || (await prepared.adapter.serverInfo());
    this.sourceInfo = prepared.source;
    this.lastError = null;
    this.lastTestAt = new Date().toISOString();
    if (
      (previous?.kind === 'mysql' || previous?.kind === 'postgres') &&
      previous !== this.adapter
    ) {
      try {
        await previous.close();
      } catch (_) {}
    }
    return this.status();
  }

  async reconnect() {
    if (!bootstrapConfigStore.exists()) {
      if (this.adapter?.kind === 'mysql' || this.adapter?.kind === 'postgres')
        try {
          await this.adapter.close();
        } catch (_) {}
      this.adapter = null;
      this.mysqlInfo = null;
      this.sourceInfo = null;
      this.state = this.legacyAvailable() ? STATES.MIGRATION_REQUIRED : STATES.UNCONFIGURED;
      this.initialized = true;
      return this.status();
    }

    const input = bootstrapConfigStore.load();
    if (!input)
      throw Object.assign(new Error('Bootstrap database configuration is missing.'), {
        code: 'DATABASE_UNCONFIGURED',
      });
    try {
      const candidate = await this.inspectMysql(input);
      this.initialized = true;
      return this.adoptInspected(candidate);
    } catch (error) {
      if (this.adapter?.kind === 'mysql' || this.adapter?.kind === 'postgres')
        try {
          await this.adapter.close();
        } catch (_) {}
      this.adapter = null;
      this.mysqlInfo = null;
      this.sourceInfo = null;
      this.state = STATES.DEGRADED;
      this.lastError = {
        code: errorCode(error) || 'MYSQL_CONNECT_FAILED',
        message:
          error instanceof Error
            ? error.message || 'MySQL connection failed.'
            : 'MySQL connection failed.',
      };
      this.lastTestAt = new Date().toISOString();
      this.initialized = true;
      return this.status();
    }
  }

  status() {
    const saved = process.env.MCP_PLATFORM === 'vercel' ? null : bootstrapConfigStore.readPublic();
    return {
      state: this.state,
      engine: this.isManagedPostgresReady()
        ? 'postgres'
        : this.isMysqlReady()
          ? 'mysql'
          : this.state === STATES.LEGACY_SQLITE || this.isRailwaySqliteReady()
            ? 'sqlite'
            : null,
      mysql: saved ? { ...saved, version: this.mysqlInfo?.version || null } : null,
      source: this.sourceInfo
        ? {
            initialized: Boolean(this.sourceInfo.initialized),
            total: Number(this.sourceInfo.total || 0),
            ran: Number(this.sourceInfo.ran || 0),
            pending: Array.isArray(this.sourceInfo.pending) ? [...this.sourceInfo.pending] : [],
          }
        : null,
      legacyAvailable: this.legacyAvailable(),
      operational: this.isOperational(),
      mysqlReady: this.isMysqlReady(),
      postgresReady: this.isManagedPostgresReady(),
      setupOnly: this.isSetupOnly(),
      lastError: this.lastError,
      lastTestAt: this.lastTestAt,
    };
  }

  async close() {
    if (this.adapter?.kind === 'mysql' || this.adapter?.kind === 'postgres')
      await this.adapter.close();
    this.adapter = null;
  }

  resetForTests() {
    this.adapter = null;
    this.state = STATES.UNCONFIGURED;
    this.mysqlInfo = null;
    this.sourceInfo = null;
    this.lastError = null;
    this.lastTestAt = null;
    this.initialized = false;
  }
}

const instance = Object.assign(new DatabaseManager(), { DatabaseManager, STATES });
export = instance;
