const crypto = require('crypto');
const databaseManager = require('../db/databaseManager');
const { SqliteAdapter } = require('../db/adapters/sqliteAdapter');

class TerminalAuditRepository {
  constructor(db = null) { this._db = db && typeof db.prepare === 'function' ? new SqliteAdapter(db) : db; }
  get db() { return this._db || databaseManager.requireAdapter(); }

  async log({ profileId = null, profileName, actorId = null, eventType, outcome, detailCode = null }) {
    return this.db.execute(`INSERT INTO terminal_connection_audit
      (id, terminal_profile_id, profile_name_snapshot, actor_id, event_type, outcome, detail_code, created_at)
      VALUES (?, (SELECT id FROM terminal_profiles WHERE id = ?), ?, ?, ?, ?, ?, ?)`, [
      crypto.randomUUID(), profileId, profileName, actorId, eventType, outcome, detailCode, new Date().toISOString()
    ]);
  }

  async findRecentForProfiles() {
    const rows = await this.db.queryAll(`SELECT a.* FROM terminal_connection_audit a
      INNER JOIN (
        SELECT terminal_profile_id, MAX(created_at) AS latest
        FROM terminal_connection_audit WHERE terminal_profile_id IS NOT NULL
        GROUP BY terminal_profile_id
      ) x ON x.terminal_profile_id = a.terminal_profile_id AND x.latest = a.created_at`);
    return Object.fromEntries(rows.map(row => [row.terminal_profile_id, row]));
  }
}

module.exports = new TerminalAuditRepository();
module.exports.TerminalAuditRepository = TerminalAuditRepository;
