import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/contracts';
import type Database from 'better-sqlite3';
import databaseManager = require('../db/databaseManager');

import { SqliteAdapter } from '../db/adapters/sqliteAdapter';

class TerminalAuditRepository {
  private _db: DatabaseAdapter | null;
  constructor(db: DatabaseAdapter | Database.Database | null = null) { this._db = db && 'prepare' in db ? new SqliteAdapter(db) : db; }
  get db() { return this._db || databaseManager.requireAdapter(); }

  async log({ profileId = null, profileName, actorId = null, eventType, outcome, detailCode = null }: {profileId?: string | null; profileName: string; actorId?: string | null; eventType: string; outcome: string; detailCode?: string | null}) {
    return this.db.execute(`INSERT INTO terminal_connection_audit
      (id, terminal_profile_id, profile_name_snapshot, actor_id, event_type, outcome, detail_code, created_at)
      VALUES (?, (SELECT id FROM terminal_profiles WHERE id = ?), ?, ?, ?, ?, ?, ?)`, [
      crypto.randomUUID(), profileId, profileName, actorId, eventType, outcome, detailCode, new Date().toISOString()
    ]);
  }

  async findRecentForProfiles() {
    const rows = await this.db.queryAll<{terminal_profile_id: string} & Record<string, unknown>>(`SELECT a.* FROM terminal_connection_audit a
      INNER JOIN (
        SELECT terminal_profile_id, MAX(created_at) AS latest
        FROM terminal_connection_audit WHERE terminal_profile_id IS NOT NULL
        GROUP BY terminal_profile_id
      ) x ON x.terminal_profile_id = a.terminal_profile_id AND x.latest = a.created_at`);
    return Object.fromEntries(rows.map(row => [row.terminal_profile_id, row]));
  }
}

const instance = Object.assign(new TerminalAuditRepository(), { TerminalAuditRepository });
export = instance;
