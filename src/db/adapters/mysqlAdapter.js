const mysql = require('mysql2/promise');

function normalizeMysqlError(error) {
  if (!error || typeof error !== 'object') return error;
  if (error.code === 'ER_DUP_ENTRY') error.code = 'DB_UNIQUE_CONSTRAINT';
  if (error.message === 'Queue limit reached.') {
    error.code = 'MYSQL_POOL_BUSY';
    error.status = 503;
  }
  return error;
}

class MysqlAdapter {
  constructor(poolOrConnection, { ownsPool = false } = {}) {
    this.kind = 'mysql';
    this._db = poolOrConnection;
    this._ownsPool = ownsPool;
  }

  static create(config) {
    const requestedQueueLimit = Number(config.queueLimit ?? process.env.MYSQL_POOL_QUEUE_LIMIT);
    const queueLimit = Number.isSafeInteger(requestedQueueLimit) && requestedQueueLimit >= 1 && requestedQueueLimit <= 10_000
      ? requestedQueueLimit : 128;
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
      ssl: config.ssl === true ? {} : (config.ssl && typeof config.ssl === 'object' ? config.ssl : undefined)
    });
    return new MysqlAdapter(pool, { ownsPool: true });
  }

  async queryOne(sql, params = []) {
    try {
      const [rows] = await this._db.execute(sql, params);
      return Array.isArray(rows) ? (rows[0] || null) : null;
    } catch (error) {
      throw normalizeMysqlError(error);
    }
  }

  async queryAll(sql, params = []) {
    try {
      const [rows] = await this._db.execute(sql, params);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      throw normalizeMysqlError(error);
    }
  }

  async execute(sql, params = []) {
    try {
      const [result] = await this._db.execute(sql, params);
      return {
        changes: Number(result?.affectedRows || 0),
        insertId: result?.insertId || null,
        warningStatus: result?.warningStatus || 0
      };
    } catch (error) {
      throw normalizeMysqlError(error);
    }
  }

  async exec(sql) {
    try {
      return await this._db.query(sql);
    } catch (error) {
      throw normalizeMysqlError(error);
    }
  }

  async ping() {
    let connection = null;
    if (this._db.getConnection) {
      try { connection = await this._db.getConnection(); }
      catch (error) { throw normalizeMysqlError(error); }
    }
    if (connection) {
      try {
        await connection.ping();
        return true;
      } finally {
        connection.release();
      }
    }
    await this._db.ping();
    return true;
  }

  async serverInfo() {
    const row = await this.queryOne('SELECT VERSION() AS version, DATABASE() AS database_name');
    return row || {};
  }

  async transaction(callback) {
    if (!this._db.getConnection) {
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

    let connection;
    try { connection = await this._db.getConnection(); }
    catch (error) { throw normalizeMysqlError(error); }
    try {
      await connection.beginTransaction();
      const result = await callback(new MysqlAdapter(connection));
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch (_) {}
      throw normalizeMysqlError(error);
    } finally {
      connection.release();
    }
  }

  async close() {
    if (this._ownsPool && this._db?.end) await this._db.end();
  }
}

module.exports = { MysqlAdapter, normalizeMysqlError };
