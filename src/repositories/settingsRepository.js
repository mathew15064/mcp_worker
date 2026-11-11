const databaseManager = require('../db/databaseManager');
const { SqliteAdapter } = require('../db/adapters/sqliteAdapter');

class SettingsRepository {
  constructor(db = null) { this._db = db && typeof db.prepare === 'function' ? new SqliteAdapter(db) : db; }
  get db() { return this._db || databaseManager.requireAdapter(); }

  async get(key, defaultValue = null) {
    const row = await this.db.queryOne('SELECT `value` FROM system_settings WHERE `key` = ?', [key]);
    return row ? row.value : defaultValue;
  }

  async set(key, value) {
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

  async delete(key) { return this.db.execute('DELETE FROM system_settings WHERE `key` = ?', [key]); }
  async all() { return this.db.queryAll('SELECT `key`, `value`, updated_at FROM system_settings ORDER BY `key`'); }
}

module.exports = new SettingsRepository();
module.exports.SettingsRepository = SettingsRepository;
