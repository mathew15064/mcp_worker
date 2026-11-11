const fs = require('fs');
const config = require('../config/env');
const bootstrapConfigStore = require('./bootstrapConfigStore');
const { getDb } = require('./connection');
const { SqliteAdapter } = require('./adapters/sqliteAdapter');
const { MysqlAdapter } = require('./adapters/mysqlAdapter');
const { MigrationRunner } = require('./migrationRunner');

const STATES = Object.freeze({
  UNCONFIGURED: 'UNCONFIGURED',
  MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
  CONFIGURED: 'CONFIGURED',
  LEGACY_SQLITE: 'LEGACY_SQLITE', // test-only compatibility adapter
  READY: 'READY',
  DEGRADED: 'DEGRADED'
});

class DatabaseManager {
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
    } catch (_) { return false; }
  }

  async inspectMysql(input) {
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

  async adoptInspected(candidate) {
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
      try { await candidate.adapter.close(); } catch (_) {}
    }

    if (previous?.kind === 'mysql' && previous !== this.adapter && previous !== candidate.adapter) {
      try { await previous.close(); } catch (_) {}
    }
    return this.status();
  }

  async initialize() {
    if (this.initialized) return this.status();
    this.initialized = true;

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

  useLegacyForTests(db = null) {
    this.initialized = true;
    this.adapter = new SqliteAdapter(db || getDb());
    this.state = STATES.LEGACY_SQLITE;
    this.mysqlInfo = null;
    this.sourceInfo = { initialized: true, migrationTable: false, total: 0, ran: 0, pending: [] };
    this.lastError = null;
    return this.adapter;
  }

  getAdapter() { return this.adapter; }

  requireAdapter() {
    if (!this.adapter || ![STATES.READY, STATES.LEGACY_SQLITE].includes(this.state)) {
      const messages = {
        [STATES.DEGRADED]: 'MySQL is configured but unavailable.',
        [STATES.CONFIGURED]: 'MySQL connection is saved but the mcp_worker source has not been initialized.',
        [STATES.MIGRATION_REQUIRED]: 'MySQL is not configured.',
        [STATES.UNCONFIGURED]: 'MySQL is not configured.'
      };
      const error = new Error(messages[this.state] || 'Application database is unavailable.');
      error.code = this.state === STATES.DEGRADED
        ? 'DATABASE_DEGRADED'
        : this.state === STATES.CONFIGURED
          ? 'DATABASE_SOURCE_UNINITIALIZED'
          : 'DATABASE_UNCONFIGURED';
      error.status = 503;
      throw error;
    }
    return this.adapter;
  }

  isOperational() { return Boolean(this.adapter) && [STATES.READY, STATES.LEGACY_SQLITE].includes(this.state); }
  isMysqlReady() { return this.state === STATES.READY && this.adapter?.kind === 'mysql'; }
  isSetupOnly() { return [STATES.UNCONFIGURED, STATES.MIGRATION_REQUIRED, STATES.CONFIGURED, STATES.DEGRADED].includes(this.state); }

  async testMysql(input) {
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
        database: info.database_name || input.database || null
      };
    } finally {
      await adapter.close();
    }
  }

  async saveMysqlConfig(input) {
    bootstrapConfigStore.save(input);
    return this.reconnect();
  }

  async prepareSourceInitialization() {
    if (!bootstrapConfigStore.exists()) {
      const error = new Error('Save the MySQL connection before initializing the source.');
      error.code = 'DATABASE_UNCONFIGURED';
      throw error;
    }

    const input = bootstrapConfigStore.load();
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
        const error = new Error('mcp_worker source initialization did not complete.');
        error.code = 'DATABASE_SOURCE_UNINITIALIZED';
        throw error;
      }
      return { adapter, info, beforeSource, source, migration, duration_ms: Date.now() - started };
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }

  async activatePrepared(prepared) {
    if (!prepared?.adapter || !prepared?.source?.initialized) {
      throw new Error('A fully initialized MySQL source is required before activation.');
    }
    const previous = this.adapter;
    this.adapter = prepared.adapter;
    this.state = STATES.READY;
    this.mysqlInfo = prepared.info || await prepared.adapter.serverInfo();
    this.sourceInfo = prepared.source;
    this.lastError = null;
    this.lastTestAt = new Date().toISOString();
    if (previous?.kind === 'mysql' && previous !== this.adapter) {
      try { await previous.close(); } catch (_) {}
    }
    return this.status();
  }

  async reconnect() {
    if (!bootstrapConfigStore.exists()) {
      if (this.adapter?.kind === 'mysql') try { await this.adapter.close(); } catch (_) {}
      this.adapter = null;
      this.mysqlInfo = null;
      this.sourceInfo = null;
      this.state = this.legacyAvailable() ? STATES.MIGRATION_REQUIRED : STATES.UNCONFIGURED;
      this.initialized = true;
      return this.status();
    }

    const input = bootstrapConfigStore.load();
    try {
      const candidate = await this.inspectMysql(input);
      this.initialized = true;
      return this.adoptInspected(candidate);
    } catch (error) {
      if (this.adapter?.kind === 'mysql') try { await this.adapter.close(); } catch (_) {}
      this.adapter = null;
      this.mysqlInfo = null;
      this.sourceInfo = null;
      this.state = STATES.DEGRADED;
      this.lastError = { code: error.code || 'MYSQL_CONNECT_FAILED', message: error.message || 'MySQL connection failed.' };
      this.lastTestAt = new Date().toISOString();
      this.initialized = true;
      return this.status();
    }
  }

  status() {
    const saved = bootstrapConfigStore.readPublic();
    return {
      state: this.state,
      engine: this.isMysqlReady() ? 'mysql' : this.state === STATES.LEGACY_SQLITE ? 'sqlite' : null,
      mysql: saved ? { ...saved, version: this.mysqlInfo?.version || null } : null,
      source: this.sourceInfo ? {
        initialized: Boolean(this.sourceInfo.initialized),
        total: Number(this.sourceInfo.total || 0),
        ran: Number(this.sourceInfo.ran || 0),
        pending: Array.isArray(this.sourceInfo.pending) ? [...this.sourceInfo.pending] : []
      } : null,
      legacyAvailable: this.legacyAvailable(),
      operational: this.isOperational(),
      mysqlReady: this.isMysqlReady(),
      setupOnly: this.isSetupOnly(),
      lastError: this.lastError,
      lastTestAt: this.lastTestAt
    };
  }

  async close() {
    if (this.adapter?.kind === 'mysql') await this.adapter.close();
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

module.exports = new DatabaseManager();
module.exports.DatabaseManager = DatabaseManager;
module.exports.STATES = STATES;
