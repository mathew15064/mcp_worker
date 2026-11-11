interface UserInput { id: string; username: string; email?: string | null; display_name: string; password_hash: string; role?: string; status?: string; principal_id: string; profile_id: string | null; session_version?: number; created_at: string; updated_at: string }
interface UserRow extends UserInput { role: string; status: string; session_version: number; last_login_at: string | null }
import type { DatabaseAdapter } from '../db/contracts';
import type Database from 'better-sqlite3';
import databaseManager = require('../db/databaseManager');


class UserRepository {
  private _db: DatabaseAdapter | null;
  constructor(db: DatabaseAdapter | null = null) { this._db = db; }
  get db() { return this._db || databaseManager.requireAdapter(); }

  async findByUsername(username: string) {
    if (!username) return null;
    return this.db.queryOne<UserRow>('SELECT * FROM users WHERE username = ?', [String(username).trim()]);
  }

  async findById(id: string) {
    if (!id) return null;
    return this.db.queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  }

  async list() {
    return this.db.queryAll<Omit<UserRow, "password_hash">>(`SELECT id, username, email, display_name, role, status, principal_id, profile_id,
      session_version, last_login_at, created_at, updated_at
      FROM users ORDER BY LOWER(username), username`);
  }

  async create(record: UserInput) {
    await this.db.execute(`INSERT INTO users
      (id, username, email, display_name, password_hash, role, status, principal_id, profile_id, session_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      record.id, record.username, record.email || null, record.display_name, record.password_hash,
      record.role || 'user', record.status || 'active', record.principal_id, record.profile_id,
      Number(record.session_version || 1), record.created_at, record.updated_at
    ]);
    return this.findById(record.id);
  }

  async updateProfile(id: string, { displayName, email }: {displayName: string; email?: string | null}) {
    const now = new Date().toISOString();
    await this.db.execute('UPDATE users SET display_name = ?, email = ?, updated_at = ? WHERE id = ?', [displayName, email || null, now, id]);
    return this.findById(id);
  }

  async updatePassword(id: string, passwordHash: string) {
    const now = new Date().toISOString();
    return this.db.execute(`UPDATE users
      SET password_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?`, [passwordHash, now, id]);
  }

  async setStatus(id: string, status: string) {
    const now = new Date().toISOString();
    return this.db.execute(`UPDATE users
      SET status = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?`, [status, now, id]);
  }

  async recordLogin(id: string) {
    const now = new Date().toISOString();
    await this.db.execute('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    return this.findById(id);
  }
}

const instance = Object.assign(new UserRepository(), { UserRepository });
export = instance;
