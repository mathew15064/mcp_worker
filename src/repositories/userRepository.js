const databaseManager = require('../db/databaseManager');

class UserRepository {
  constructor(db = null) { this._db = db; }
  get db() { return this._db || databaseManager.requireAdapter(); }

  async findByUsername(username) {
    if (!username) return null;
    return this.db.queryOne('SELECT * FROM users WHERE username = ?', [String(username).trim()]);
  }

  async findById(id) {
    if (!id) return null;
    return this.db.queryOne('SELECT * FROM users WHERE id = ?', [id]);
  }

  async list() {
    return this.db.queryAll(`SELECT id, username, email, display_name, role, status, principal_id, profile_id,
      session_version, last_login_at, created_at, updated_at
      FROM users ORDER BY LOWER(username), username`);
  }

  async create(record) {
    await this.db.execute(`INSERT INTO users
      (id, username, email, display_name, password_hash, role, status, principal_id, profile_id, session_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      record.id, record.username, record.email || null, record.display_name, record.password_hash,
      record.role || 'user', record.status || 'active', record.principal_id, record.profile_id,
      Number(record.session_version || 1), record.created_at, record.updated_at
    ]);
    return this.findById(record.id);
  }

  async updateProfile(id, { displayName, email }) {
    const now = new Date().toISOString();
    await this.db.execute('UPDATE users SET display_name = ?, email = ?, updated_at = ? WHERE id = ?', [displayName, email || null, now, id]);
    return this.findById(id);
  }

  async updatePassword(id, passwordHash) {
    const now = new Date().toISOString();
    return this.db.execute(`UPDATE users
      SET password_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?`, [passwordHash, now, id]);
  }

  async setStatus(id, status) {
    const now = new Date().toISOString();
    return this.db.execute(`UPDATE users
      SET status = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?`, [status, now, id]);
  }

  async recordLogin(id) {
    const now = new Date().toISOString();
    await this.db.execute('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    return this.findById(id);
  }
}

module.exports = new UserRepository();
module.exports.UserRepository = UserRepository;
