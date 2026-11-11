import session = require('express-session');
import type { SessionData } from 'express-session';
type Callback = (err?: unknown) => void;
type GetCallback = (err: unknown, data?: SessionData | null) => void;

class BoundedMemorySessionStore extends session.Store {
  maxSessions: number;
  sessions: Map<string, {session: SessionData; expired: number}>;
  cleanupInterval: NodeJS.Timeout;
  constructor({ maxSessions = 500, cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.maxSessions = Math.max(10, Number(maxSessions) || 500);
    this.sessions = new Map();
    this.cleanupInterval = setInterval(() => this.clearExpired(), cleanupIntervalMs);
    this.cleanupInterval.unref?.();
  }

  _expiry(sess: SessionData) {
    const maxAge = sess?.cookie && typeof sess.cookie.maxAge === 'number' ? sess.cookie.maxAge : 24 * 60 * 60 * 1000;
    return Date.now() + maxAge;
  }

  _clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

  clearExpired() {
    const now = Date.now();
    for (const [sid, record] of this.sessions.entries()) {
      if (record.expired <= now) this.sessions.delete(sid);
    }
  }

  _evictIfNeeded() {
    this.clearExpired();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  get(sid: string, cb: GetCallback) {
    try {
      const record = this.sessions.get(sid);
      if (!record || record.expired <= Date.now()) {
        this.sessions.delete(sid);
        return cb(null, null);
      }
      this.sessions.delete(sid);
      this.sessions.set(sid, record);
      cb(null, this._clone(record.session));
    } catch (error) { cb(error); }
  }

  set(sid: string, sess: SessionData, cb?: Callback) {
    try {
      if (!this.sessions.has(sid)) this._evictIfNeeded();
      this.sessions.set(sid, { session: this._clone(sess), expired: this._expiry(sess) });
      cb?.(null);
    } catch (error) { cb?.(error); }
  }

  destroy(sid: string, cb?: Callback) {
    this.sessions.delete(sid);
    cb?.(null);
  }

  touch(sid: string, sess: SessionData, cb?: Callback) {
    const record = this.sessions.get(sid);
    if (record) {
      record.expired = this._expiry(sess);
      record.session = this._clone(sess);
      this.sessions.delete(sid);
      this.sessions.set(sid, record);
    }
    cb?.(null);
  }

  clear(cb?: Callback) {
    this.sessions.clear();
    cb?.(null);
  }

  close() { clearInterval(this.cleanupInterval); this.sessions.clear(); }
}

export = BoundedMemorySessionStore;
