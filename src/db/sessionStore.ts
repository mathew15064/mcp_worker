import session from 'express-session';
import crypto from 'node:crypto';
import type { SessionData } from 'express-session';
type Callback = (err?: unknown) => void;
type GetCallback = (err: unknown, data?: SessionData | null) => void;
import { getDb } from './connection';
import type Database from 'better-sqlite3';

function isRailwayAdminSession(data: SessionData) {
  return (
    process.env.MCP_PLATFORM === 'railway' &&
    data.userId === 'env-admin' &&
    data.role === 'admin'
  );
}

function credentialFingerprint(db: Database.Database) {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM system_settings WHERE key = ?')
    .get('bootstrap.admin_password_hash');
  return row?.value ? crypto.createHash('sha256').update(row.value).digest('hex') : null;
}

class SqliteSessionStore extends session.Store {
  private _customDb: Database.Database | null;
  cleanupInterval: NodeJS.Timeout;
  constructor(options: { db?: Database.Database } = {}) {
    super();
    this._customDb = options.db || null;

    // Periodically clean up expired sessions every 15 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.clearExpired();
      },
      15 * 60 * 1000,
    );
    this.cleanupInterval.unref();
  }

  get db() {
    return this._customDb || getDb();
  }

  close() {
    clearInterval(this.cleanupInterval);
  }

  clearExpired() {
    try {
      const now = Date.now();
      this.db.prepare('DELETE FROM sessions WHERE expired < ?').run(now);
    } catch (err) {
      // ignore
    }
  }

  get(sid: string, cb: GetCallback) {
    try {
      const now = Date.now();
      const row = this.db
        .prepare<[string], { sess: string; expired: number }>(
          'SELECT sess, expired FROM sessions WHERE sid = ?',
        )
        .get(sid);
      if (!row) {
        return cb(null, null);
      }
      if (row.expired < now) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      const data = JSON.parse(row.sess);
      const adminSession = data as SessionData;
      if (isRailwayAdminSession(adminSession)) {
        const fingerprint = credentialFingerprint(this.db);
        if (!fingerprint || adminSession.adminCredentialFingerprint !== fingerprint) {
          return this.destroy(sid, (error) => cb(error || null, null));
        }
      }
      return cb(null, data);
    } catch (err) {
      return cb(err);
    }
  }

  set(sid: string, sess: SessionData, cb?: Callback) {
    try {
      let maxAge = 24 * 60 * 60 * 1000; // default 24h
      if (sess && sess.cookie && typeof sess.cookie.maxAge === 'number') {
        maxAge = sess.cookie.maxAge;
      }
      const expired = Date.now() + maxAge;
      if (isRailwayAdminSession(sess)) {
        const fingerprint = credentialFingerprint(this.db);
        if (
          !fingerprint ||
          (sess.adminCredentialFingerprint && sess.adminCredentialFingerprint !== fingerprint)
        ) {
          throw new Error('Admin credentials changed; session must be renewed.');
        }
        sess.adminCredentialFingerprint = fingerprint;
      }
      const sessStr = JSON.stringify(sess);

      this.db
        .prepare(
          `
        INSERT INTO sessions (sid, sess, expired)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
      `,
        )
        .run(sid, sessStr, expired);

      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid: string, cb?: Callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  touch(sid: string, sess: SessionData, cb?: Callback) {
    try {
      let maxAge = 24 * 60 * 60 * 1000;
      if (sess && sess.cookie && typeof sess.cookie.maxAge === 'number') {
        maxAge = sess.cookie.maxAge;
      }
      const expired = Date.now() + maxAge;
      this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(expired, sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }
}

export = SqliteSessionStore;
