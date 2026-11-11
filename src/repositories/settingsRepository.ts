import type { DatabaseAdapter } from '../db/contracts';
import type Database from 'better-sqlite3';
import databaseManager = require('../db/databaseManager');

import { SqliteAdapter } from '../db/adapters/sqliteAdapter';

class SettingsRepository {
  private _db: DatabaseAdapter | null;
  constructor(db: DatabaseAdapter | Database.Database | null = null) { this._db = db && 'prepare' in db ? new SqliteAdapter(db) : db; }
  get db() { return this._db || databaseManager.requireAdapter(); }

  async get<T = null>(key: string, defaultValue: T | null = null) {
    const row = await this.db.queryOne<{value: string}>('SELECT `value` FROM system_settings WHERE `key` = ?', [key]);
    return row ? row.value : defaultValue;
  }

  async set(key: string, value: unknown) {
    const now = new Date().toISOString();
    if (this.db.kind === 'mysql') {
      return this.db.execute(`
        INSERT INTO system_settings (\`key\`, \`value\`, updated_at)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = VALUES(updated_at)
      `, [key, String(value ?? ''), now]);
    }
    return this.db.execute(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `, [key, String(value ?? ''), now]);
  }

  async delete(key: string) { return this.db.execute('DELETE FROM system_settings WHERE `key` = ?', [key]); }
  async all() { return this.db.queryAll('SELECT `key`, `value`, updated_at FROM system_settings ORDER BY `key`'); }
}

const instance = Object.assign(new SettingsRepository(), { SettingsRepository });
export = instance;
