import { Pool, type PoolClient } from 'pg';
import type { DatabaseAdapter, SqlRow, SqlValue } from '../contracts';

type PgDb = Pool | PoolClient;

function sqlError(error: unknown): unknown {
  if (error && typeof error === 'object' && 'code' in error) {
    const e = error as { code?: string; status?: number };
    if (e.code === '23505') e.code = 'DB_UNIQUE_CONSTRAINT';
  }
  return error;
}

/** Converts trusted repository SQL to PostgreSQL; never interpolates inputs. */
export function postgresSql(source: string): string {
  let sql = source
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/\bDATABASE\(\)/gi, 'current_schema()')
    .replace(/\bLONGTEXT\b/gi, 'TEXT')
    .replace(/\bTINYINT\(1\)/gi, 'SMALLINT')
    .replace(/\bINT\b/gi, 'INTEGER')
    .replace(/\s+ENGINE=InnoDB\s+DEFAULT\s+CHARSET=utf8mb4\s+COLLATE=utf8mb4_unicode_ci/gi, '')
    .replace(/\bBIGINT\s+NOT\s+NULL\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, 'BIGSERIAL PRIMARY KEY');
  const addIndex = sql.match(
    /^ALTER TABLE ("[A-Za-z0-9_]+") ADD INDEX ("[A-Za-z0-9_]+") \((.+)\)$/i,
  );
  if (addIndex)
    sql = `CREATE INDEX IF NOT EXISTS ${addIndex[2]} ON ${addIndex[1]} (${addIndex[3]})`;
  const dropIndex = sql.match(/^ALTER TABLE ("[A-Za-z0-9_]+") DROP INDEX ("[A-Za-z0-9_]+")$/i);
  if (dropIndex) sql = `DROP INDEX IF EXISTS ${dropIndex[2]}`;
  sql = sql.replace(/\bDROP FOREIGN KEY\b/gi, 'DROP CONSTRAINT');
  let bindIndex = 0;
  let quote: "'" | '"' | null = null;
  let rendered = '';
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      rendered += char;
      if (char === quote) {
        if (sql[i + 1] === quote) rendered += sql[++i];
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      rendered += char;
    } else if (char === '?') rendered += '$' + ++bindIndex;
    else rendered += char;
  }
  return rendered;
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly kind = 'postgres' as const;
  private readonly db: PgDb;
  private readonly ownsPool: boolean;
  constructor(db: PgDb, ownsPool = false) {
    this.db = db;
    this.ownsPool = ownsPool;
  }
  static create(url: string) {
    const connection = new URL(url);
    if (!['postgresql:', 'postgres:'].includes(connection.protocol))
      throw new Error('Expected a PostgreSQL connection URL.');
    if (!connection.hostname || !connection.pathname || !connection.username)
      throw new Error('Incomplete PostgreSQL connection URL.');
    const pool = new Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 7000,
      idleTimeoutMillis: 15000,
      allowExitOnIdle: true,
    });
    return new PostgresAdapter(pool, true);
  }
  private query(sql: string, params: SqlValue[] = []) {
    return this.db.query(postgresSql(sql), params).catch((e) => {
      throw sqlError(e);
    });
  }
  async queryOne<T extends object = SqlRow>(sql: string, params: SqlValue[] = []) {
    const row = (await this.query(sql, params)).rows[0] as T | undefined;
    return row || null;
  }
  async queryAll<T extends object = SqlRow>(sql: string, params: SqlValue[] = []) {
    return (await this.query(sql, params)).rows as T[];
  }
  async execute(sql: string, params: SqlValue[] = []) {
    const r = await this.query(sql, params);
    return { changes: r.rowCount || 0, insertId: null };
  }
  async exec(sql: string) {
    return this.query(sql);
  }
  async ping() {
    await this.query('SELECT 1');
    return true;
  }
  async serverInfo() {
    return this.queryOne('SELECT VERSION() AS version, current_database() AS database_name');
  }
  async transaction<T>(callback: (tx: DatabaseAdapter) => Promise<T> | T): Promise<T> {
    if (!this.ownsPool) {
      await this.db.query('SAVEPOINT worker_tx');
      try {
        const result = await callback(this);
        await this.db.query('RELEASE SAVEPOINT worker_tx');
        return result;
      } catch (error) {
        await this.db.query('ROLLBACK TO SAVEPOINT worker_tx');
        throw error;
      }
    }
    const client = await (this.db as Pool).connect();
    try {
      await client.query('BEGIN');
      const result = await callback(new PostgresAdapter(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw sqlError(error);
    } finally {
      client.release();
    }
  }
  async close() {
    if (this.ownsPool) await (this.db as Pool).end();
  }
}
