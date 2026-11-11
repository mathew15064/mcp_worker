const { AsyncLocalStorage } = require('async_hooks');
const { getDb } = require('../connection');

class SqliteAdapter {
  constructor(db = null, options = {}) {
    this.kind = 'sqlite';
    this._db = db || getDb();
    this._direct = Boolean(options.direct);
    this._queue = options.queue || { tail: Promise.resolve() };
    this._txStorage = options.txStorage || new AsyncLocalStorage();
  }

  _runExclusive(fn) {
    if (this._direct || this._txStorage.getStore()) return Promise.resolve().then(fn);
    const next = this._queue.tail.then(fn, fn);
    this._queue.tail = next.catch(() => {});
    return next;
  }

  async queryOne(sql, params = []) {
    return this._runExclusive(() => this._db.prepare(sql).get(...params) || null);
  }

  async queryAll(sql, params = []) {
    return this._runExclusive(() => this._db.prepare(sql).all(...params));
  }

  async execute(sql, params = []) {
    return this._runExclusive(() => {
      const result = this._db.prepare(sql).run(...params);
      return { changes: result.changes || 0, insertId: result.lastInsertRowid || null };
    });
  }

  async exec(sql) {
    return this._runExclusive(() => this._db.exec(sql));
  }

  async ping() {
    await this.queryOne('SELECT 1 AS ok');
    return true;
  }

  async transaction(callback) {
    return this._runExclusive(async () => {
      this._db.exec('BEGIN IMMEDIATE');
      const tx = new SqliteAdapter(this._db, {
        direct: true,
        queue: this._queue,
        txStorage: this._txStorage
      });
      try {
        const result = await this._txStorage.run({ active: true }, () => callback(tx));
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this._db.exec('ROLLBACK'); } catch (_) {}
        throw error;
      }
    });
  }

  async close() {
    // The shared SQLite connection is owned by src/db/connection.js.
  }
}

module.exports = { SqliteAdapter };
