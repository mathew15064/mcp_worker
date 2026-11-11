import mysql from 'mysql2/promise';
import type {
  Pool,
  Connection,
  PoolConnection,
  ResultSetHeader,
  PoolOptions,
} from 'mysql2/promise';
import type { DatabaseAdapter, SqlRow, SqlValue } from '../contracts';
interface MysqlConfig {
  host: string;
  port?: number | string;
  username: string;
  password: string;
  database: string;
  queueLimit?: number;
  connectionLimit?: number;
  connectTimeoutMs?: number;
  ssl?: boolean | Exclude<PoolOptions['ssl'], string | undefined>;
}
type MysqlDriver = Pool | Connection;
function isPool(db: MysqlDriver): db is Pool {
  return 'getConnection' in db;
}

export function normalizeMysqlError(error: unknown) {
  if (!error || typeof error !== 'object') return error;
  const mutable = error as { code?: string; message?: string; status?: number };
  if (mutable.code === 'ER_DUP_ENTRY') mutable.code = 'DB_UNIQUE_CONSTRAINT';
  if (mutable.message === 'Queue limit reached.') {
    mutable.code = 'MYSQL_POOL_BUSY';
    mutable.status = 503;
  }
  return error;
}

export class MysqlAdapter implements DatabaseAdapter {
  readonly kind = 'mysql' as const;
  private _db: MysqlDriver;
  private _ownsPool: boolean;
  constructor(poolOrConnection: MysqlDriver, { ownsPool = false } = {}) {
    this._db = poolOrConnection;
    this._ownsPool = ownsPool;
  }

  static create(config: MysqlConfig) {
    const requestedQueueLimit = Number(config.queueLimit ?? process.env.MYSQL_POOL_QUEUE_LIMIT);
    const queueLimit =
      Number.isSafeInteger(requestedQueueLimit) &&
      requestedQueueLimit >= 1 &&
      requestedQueueLimit <= 10_000
        ? requestedQueueLimit
        : 128;
    const pool = mysql.createPool({
      host: config.host,
      port: Number(config.port || 3306),
      user: config.username,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: Number(config.connectionLimit || 10),
      queueLimit,
      connectTimeout: Number(config.connectTimeoutMs || 5000),
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true,
      decimalNumbers: true,
      ssl:
        config.ssl === true
          ? {}
          : config.ssl && typeof config.ssl === 'object'
            ? config.ssl
            : undefined,
    });
    return new MysqlAdapter(pool, { ownsPool: true });
  }

  async queryOne<T extends object = SqlRow>(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<T | null> {
    try {
      const [rows] = await this._db.execute(sql, params);
      return Array.isArray(rows) ? (rows[0] as T) || null : null;
    } catch (error) {
      throw normalizeMysqlError(error);
    }
  }

  async queryAll<T extends object = SqlRow>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    try {
      const [rows] = await this._db.execute(sql, params);
      return Array.isArray(rows) ? (rows as T[]) : [];
    } catch (error) {
      throw normalizeMysqlError(error);
    }
  }

  async execute(sql: string, params: SqlValue[] = []) {
    try {
      const [result] = await this._db.execute<ResultSetHeader>(sql, params);
      return {
        changes: Number(result?.affectedRows || 0),
        insertId: result?.insertId || null,
        warningStatus: result?.warningStatus || 0,
      };
    } catch (error) {
      throw normalizeMysqlError(error);
    }
  }

  async exec(sql: string) {
    try {
      return await this._db.query(sql);
    } catch (error) {
      throw normalizeMysqlError(error);
    }
  }

  async ping() {
    let connection: PoolConnection | null = null;
    if (isPool(this._db)) {
      try {
        connection = await this._db.getConnection();
      } catch (error) {
        throw normalizeMysqlError(error);
      }
    }
    if (connection) {
      try {
        await connection.ping();
        return true;
      } finally {
        connection.release();
      }
    }
    if (!isPool(this._db)) await this._db.ping();
    return true;
  }

  async serverInfo() {
    const row = await this.queryOne('SELECT VERSION() AS version, DATABASE() AS database_name');
    return row || {};
  }

  async transaction<T>(callback: (tx: DatabaseAdapter) => Promise<T> | T): Promise<T> {
    if (!isPool(this._db)) {
      await this._db.beginTransaction();
      try {
        const result = await callback(new MysqlAdapter(this._db));
        await this._db.commit();
        return result;
      } catch (error) {
        await this._db.rollback();
        throw error;
      }
    }

    let connection: PoolConnection;
    try {
      connection = await this._db.getConnection();
    } catch (error) {
      throw normalizeMysqlError(error);
    }
    try {
      await connection.beginTransaction();
      const result = await callback(new MysqlAdapter(connection));
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (_) {}
      throw normalizeMysqlError(error);
    } finally {
      connection.release();
    }
  }

  async close() {
    if (this._ownsPool && this._db?.end) await this._db.end();
  }
}
