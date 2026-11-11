import fs from 'node:fs';
import path from 'node:path';
import { SchemaBuilder } from './schemaBuilder';
import type { DatabaseAdapter } from './contracts';
interface Migration {
  up(schema: SchemaBuilder): Promise<void>;
  down(schema: SchemaBuilder): Promise<void>;
}
interface MigrationRecord {
  migration: string;
  batch: number;
  executed_at: string;
  id: number;
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_\d{2}_\d{2}_\d{6}_[A-Za-z0-9_]+\.js$/.test(name))
    .sort();
}

export function migrationName(file: string) {
  return file.replace(/\.js$/, '');
}
function loadMigration(file: string): Migration {
  const full = path.join(MIGRATIONS_DIR, file);
  delete require.cache[require.resolve(full)];
  const migration: Migration = require(full);
  if (!migration || typeof migration.up !== 'function' || typeof migration.down !== 'function') {
    throw new Error(`Migration '${file}' must export async up(schema) and down(schema).`);
  }
  return migration;
}

export class MigrationRunner {
  adapter: DatabaseAdapter;
  schema: SchemaBuilder;
  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
    this.schema = new SchemaBuilder(adapter);
  }

  async ensureTable() {
    if (this.adapter.kind === 'libsql') {
      await this.adapter.exec(`CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration TEXT NOT NULL UNIQUE,
        batch INTEGER NOT NULL,
        executed_at TEXT NOT NULL
      )`);
    } else {
      await this.adapter.exec(`CREATE TABLE IF NOT EXISTS migrations (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        migration VARCHAR(255) NOT NULL UNIQUE,
        batch INT NOT NULL,
        executed_at VARCHAR(40) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    }
  }

  async executed() {
    await this.ensureTable();
    return this.adapter.queryAll<MigrationRecord>(
      'SELECT id, migration, batch, executed_at FROM migrations ORDER BY id ASC',
    );
  }

  async inspectSource() {
    const files = migrationFiles();
    const table = await this.adapter.queryOne(
      this.adapter.kind === 'libsql'
        ? "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'migrations'"
        : "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'migrations'",
    );
    if (Number(table?.count || 0) === 0) {
      return {
        initialized: false,
        migrationTable: false,
        total: files.length,
        ran: 0,
        pending: files.map(migrationName),
      };
    }

    const executed = await this.adapter.queryAll<{ migration: string }>(
      'SELECT migration FROM migrations ORDER BY id ASC',
    );
    const ran = new Set(executed.map((row) => String(row.migration)));
    const pending = files.map(migrationName).filter((name) => !ran.has(name));
    return {
      initialized: files.length > 0 && pending.length === 0,
      migrationTable: true,
      total: files.length,
      ran: files.length - pending.length,
      pending,
    };
  }

  async status() {
    const ran = await this.executed();
    const ranByName = new Map(ran.map((row) => [row.migration, row]));
    return migrationFiles().map((file) => {
      const name = migrationName(file);
      const record = ranByName.get(name);
      return {
        migration: name,
        ran: Boolean(record),
        batch: record ? Number(record.batch) : null,
        executed_at: record?.executed_at || null,
      };
    });
  }

  private async retryBusy<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const details =
          error && typeof error === 'object'
            ? (error as { code?: string; extendedCode?: string })
            : {};
        const busy = [details.code, details.extendedCode].some(
          (code) => code === 'SQLITE_BUSY' || code === 'LIBSQL_BUSY',
        );
        if (!busy || attempt >= 7) throw error;
        // SQLite has one active writer; retry with bounded backoff.
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(25 * (attempt + 1) ** 2, 400)),
        );
      }
    }
  }

  async migrate() {
    if (this.adapter.kind === 'libsql') await this.retryBusy(() => this.ensureTable());
    else await this.ensureTable();

    // SQLite/libSQL DDL is transactional. A write transaction for each
    // migration serializes concurrent initializers, and a second instance
    // rechecks the committed migration name after acquiring the write lock.
    // MySQL retains the original migration behavior and SQL below.
    if (this.adapter.kind === 'libsql') {
      const initial = await this.adapter.queryOne<{ batch: number }>(
        'SELECT COALESCE(MAX(batch), 0) AS batch FROM migrations',
      );
      const batch = Number(initial?.batch || 0) + 1;
      const completed: string[] = [];
      for (const file of migrationFiles()) {
        const name = migrationName(file);
        const applied = await this.retryBusy(() =>
          this.adapter.transaction(async (tx) => {
            const executed = await tx.queryOne(
              'SELECT migration FROM migrations WHERE migration = ?',
              [name],
            );
            if (executed) return false;
            await loadMigration(file).up(new SchemaBuilder(tx));
            await tx.execute(
              'INSERT INTO migrations (migration, batch, executed_at) VALUES (?, ?, ?)',
              [name, batch, new Date().toISOString()],
            );
            return true;
          }),
        );
        // Only record success after the transaction commit, not before.
        if (applied) completed.push(name);
      }
      return { batch: completed.length ? batch : null, ran: completed };
    }

    const ran = new Set((await this.executed()).map((row) => row.migration));
    const pending = migrationFiles().filter((file) => !ran.has(migrationName(file)));
    if (!pending.length) return { batch: null, ran: [] };
    const row = await this.adapter.queryOne(
      'SELECT COALESCE(MAX(batch), 0) AS batch FROM migrations',
    );
    const batch = Number(row?.batch || 0) + 1;
    const completed = [];
    for (const file of pending) {
      const name = migrationName(file);
      await loadMigration(file).up(this.schema);
      await this.adapter.execute(
        'INSERT INTO migrations (migration, batch, executed_at) VALUES (?, ?, ?)',
        [name, batch, new Date().toISOString()],
      );
      completed.push(name);
    }
    return { batch, ran: completed };
  }

  async rollback({ steps = null }: { steps?: number | null } = {}) {
    await this.ensureTable();
    let rows: { migration: string }[] = [];
    if (steps !== null && steps !== undefined) {
      const count = Math.max(1, Number(steps) || 1);
      rows = await this.adapter.queryAll<{ migration: string }>(
        'SELECT migration FROM migrations ORDER BY id DESC LIMIT ?',
        [count],
      );
    } else {
      const latest = await this.adapter.queryOne<{ batch: number | null }>(
        'SELECT MAX(batch) AS batch FROM migrations',
      );
      if (latest?.batch !== null && latest?.batch !== undefined) {
        rows = await this.adapter.queryAll<{ migration: string }>(
          'SELECT migration FROM migrations WHERE batch = ? ORDER BY id DESC',
          [latest.batch],
        );
      }
    }

    const rolledBack = [];
    for (const row of rows) {
      const file = `${row.migration}.js`;
      if (!migrationFiles().includes(file))
        throw new Error(`Migration file missing for '${row.migration}'.`);
      await loadMigration(file).down(this.schema);
      await this.adapter.execute('DELETE FROM migrations WHERE migration = ?', [row.migration]);
      rolledBack.push(row.migration);
    }
    return { rolledBack };
  }

  async reset() {
    await this.ensureTable();
    const rows = await this.adapter.queryAll<{ migration: string }>(
      'SELECT migration FROM migrations ORDER BY id DESC',
    );
    const rolledBack = [];
    for (const row of rows) {
      const file = `${row.migration}.js`;
      if (!migrationFiles().includes(file))
        throw new Error(`Migration file missing for '${row.migration}'.`);
      await loadMigration(file).down(this.schema);
      await this.adapter.execute('DELETE FROM migrations WHERE migration = ?', [row.migration]);
      rolledBack.push(row.migration);
    }
    return { rolledBack };
  }

  async fresh({ allowDestructive = false } = {}) {
    if (!allowDestructive) {
      const error = Object.assign(
        new Error('Fresh migration is destructive and requires explicit allowDestructive=true.'),
        { code: 'DESTRUCTIVE_MIGRATION_BLOCKED' },
      );
      throw error;
    }
    await this.reset();
    return this.migrate();
  }
}
