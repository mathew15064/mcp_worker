import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SchemaBuilder } from './schemaBuilder';
import { MysqlAdapter } from './adapters/mysqlAdapter';
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
  const migration = createRequire(__filename)(full) as Migration;
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
    await this.adapter.exec(`CREATE TABLE IF NOT EXISTS migrations (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      migration VARCHAR(255) NOT NULL UNIQUE,
      batch INT NOT NULL,
      executed_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  async executed() {
    await this.ensureTable();
    return this.adapter.queryAll<MigrationRecord>(
      'SELECT id, migration, batch, executed_at FROM migrations ORDER BY id ASC',
    );
  }

  private async assertMysqlSchema() {
    const required: Record<string, string[]> = {
      system_settings: ['key', 'value', 'updated_at'],
      terminal_profiles: ['id', 'credential_envelope'],
      terminal_connection_audit: ['id', 'terminal_profile_id'],
      mcp_oauth_clients: ['id', 'client_id', 'allowed_scopes_json', 'owner_user_id'],
      mcp_oauth_authorization_codes: ['id', 'code_hash', 'client_id'],
      mcp_oauth_access_tokens: ['id', 'token_hash', 'client_id', 'revoked_at'],
      mcp_oauth_refresh_tokens: ['id', 'token_hash', 'client_id', 'revoked_at'],
      mcp_request_audit: ['id', 'request_payload', 'response_payload'],
      workers: ['id', 'owner_user_id'],
      worker_enrollment_tokens: ['id', 'owner_user_id'],
      worker_profiles: ['id', 'worker_id'],
      users: ['id', 'username', 'session_version'],
    };
    const columns = await this.adapter.queryAll<{ TABLE_NAME: string; COLUMN_NAME: string }>(
      'SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE()',
    );
    const found = new Map<string, Set<string>>();
    for (const column of columns) {
      if (!found.has(column.TABLE_NAME)) found.set(column.TABLE_NAME, new Set());
      found.get(column.TABLE_NAME)?.add(column.COLUMN_NAME);
    }
    for (const [table, names] of Object.entries(required)) {
      if (names.some((column) => !found.get(table)?.has(column))) {
        throw Object.assign(
          new Error(`MySQL source schema is missing required columns: ${table}`),
          {
            code: 'MYSQL_SCHEMA_INCOMPATIBLE',
          },
        );
      }
    }
    const indexed = await this.adapter.queryAll<{ TABLE_NAME: string; INDEX_NAME: string }>(
      'SELECT DISTINCT TABLE_NAME, INDEX_NAME FROM information_schema.statistics WHERE table_schema = DATABASE()',
    );
    const indexes = new Set(indexed.map((row) => `${row.TABLE_NAME}.${row.INDEX_NAME}`));
    for (const [table, index] of [
      ['mcp_oauth_clients', 'idx_mcp_clients_owner_user'],
      ['workers', 'idx_workers_owner_user'],
      ['worker_enrollment_tokens', 'idx_worker_enrollment_owner_user'],
      ['mcp_oauth_access_tokens', 'idx_mcp_access_tokens_client'],
      ['mcp_oauth_refresh_tokens', 'idx_mcp_refresh_tokens_client'],
    ]) {
      if (!indexes.has(`${table}.${index}`)) {
        throw Object.assign(new Error(`MySQL source schema is missing index ${table}.${index}`), {
          code: 'MYSQL_SCHEMA_INCOMPATIBLE',
        });
      }
    }
    const references = await this.adapter.queryAll<{
      TABLE_NAME: string;
      REFERENCED_TABLE_NAME: string;
      COLUMN_NAME: string;
    }>(
      `SELECT TABLE_NAME, REFERENCED_TABLE_NAME, COLUMN_NAME
       FROM information_schema.key_column_usage WHERE table_schema = DATABASE()
       AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );
    for (const table of ['mcp_oauth_clients', 'workers', 'worker_enrollment_tokens']) {
      if (
        !references.some(
          (row) =>
            row.TABLE_NAME === table &&
            row.COLUMN_NAME === 'owner_user_id' &&
            row.REFERENCED_TABLE_NAME === 'users',
        )
      ) {
        throw Object.assign(new Error(`MySQL source schema is missing ownership FK: ${table}`), {
          code: 'MYSQL_SCHEMA_INCOMPATIBLE',
        });
      }
    }
  }

  async inspectSource() {
    const files = migrationFiles();
    const table = await this.adapter.queryOne(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'migrations'",
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
    if (files.length > 0 && pending.length === 0) await this.assertMysqlSchema();
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

  async migrate() {
    // MySQL DDL commits independently of the ledger. Serialize every startup
    // on one pinned connection and recheck the ledger *inside* that lock.
    if (this.adapter instanceof MysqlAdapter) {
      return this.adapter.withMigrationLock((locked) =>
        new MigrationRunner(locked).migrateUnlocked(),
      );
    }
    return this.migrateUnlocked();
  }

  private async migrateUnlocked() {
    await this.ensureTable();
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
