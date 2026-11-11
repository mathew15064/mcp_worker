import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { DatabaseAdapter, SqlRow, SqlValue } from '../contracts';
interface Queue { tail: Promise<unknown> }
interface TxContext { active: boolean }
interface SqliteOptions { direct?: boolean; queue?: Queue; txStorage?: AsyncLocalStorage<TxContext> }
import { getDb } from '../connection';

export class SqliteAdapter implements DatabaseAdapter {
  readonly kind = 'sqlite' as const;
  private _db: Database.Database;
  private _direct: boolean;
  private _queue: Queue;
  private _txStorage: AsyncLocalStorage<TxContext>;
  constructor(db: Database.Database | null = null, options: SqliteOptions = {}) {
    this._db = db || getDb();
    this._direct = Boolean(options.direct);
    this._queue = options.queue || { tail: Promise.resolve() };
    this._txStorage = options.txStorage || new AsyncLocalStorage<TxContext>();
  }

  _runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this._direct || this._txStorage.getStore()) return Promise.resolve().then(fn);
    const next = this._queue.tail.then(fn, fn);
    this._queue.tail = next.catch(() => {});
    return next;
  }

  async queryOne<T extends object = SqlRow>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return this._runExclusive(() => this._db.prepare<SqlValue[], T>(sql).get(...params) || null);
  }

  async queryAll<T extends object = SqlRow>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this._runExclusive(() => this._db.prepare<SqlValue[], T>(sql).all(...params));
  }

  async execute(sql: string, params: SqlValue[] = []) {
    return this._runExclusive(() => {
      const result = this._db.prepare(sql).run(...params);
      return { changes: result.changes || 0, insertId: result.lastInsertRowid || null };
    });
  }

  async exec(sql: string) {
    return this._runExclusive(() => this._db.exec(sql));
  }

  async ping() {
    await this.queryOne('SELECT 1 AS ok');
    return true;
  }

  async transaction<T>(callback: (tx: DatabaseAdapter) => Promise<T> | T): Promise<T> {
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
