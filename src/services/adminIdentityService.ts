import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import Database = require('better-sqlite3');
import config = require('../config/env');
import databaseManager = require('../db/databaseManager');
interface AdminSession {userId?: string; role?: string; sessionVersion?: number; authSource?: string}

export const ADMIN_ID = 'env-admin';
export const SESSION_VERSION = 1;

export function timingSafeStringEqual(a: unknown, b: unknown) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export function identity(authSource = 'env') {
  return {
    id: ADMIN_ID,
    username: config.ADMIN_USERNAME,
    role: 'admin',
    session_version: SESSION_VERSION,
    auth_source: authSource,
    created_at: null,
    updated_at: null
  };
}

function envAuthenticate(username: unknown, password: unknown) {
  const configuredPassword = config.ADMIN_PASSWORD;
  if (!configuredPassword || configuredPassword.trim().length < 8) {
    const error = Object.assign(new Error('ADMIN_PASSWORD must be configured with at least 8 characters.'), {code: 'ADMIN_PASSWORD_INVALID'});
    throw error;
  }
  return timingSafeStringEqual(String(username || ''), config.ADMIN_USERNAME)
    && timingSafeStringEqual(String(password || ''), configuredPassword);
}

function legacyAuthenticate(username: unknown, password: unknown) {
  if (databaseManager.status().state !== 'MIGRATION_REQUIRED' || !databaseManager.legacyAvailable()) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(config.DATABASE_PATH, { readonly: true, fileMustExist: true });
    const row = db.prepare<[], {username: string; password_hash: string}>("SELECT username, password_hash FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get();
    if (!row || !timingSafeStringEqual(String(username || ''), String(row.username || ''))) return false;
    return bcrypt.compareSync(String(password || ''), String(row.password_hash || ''));
  } catch (_) {
    return false;
  } finally {
    try { db?.close(); } catch (_) {}
  }
}

export function authenticate(username: unknown, password: unknown) {
  if (envAuthenticate(username, password)) return identity('env');
  if (legacyAuthenticate(username, password)) return identity('legacy');
  return null;
}

export function currentFromSession(session: AdminSession | null | undefined) {
  if (!session || session.userId !== ADMIN_ID || session.role !== 'admin') return null;
  if ((session.sessionVersion || SESSION_VERSION) !== SESSION_VERSION) return null;
  return identity(session.authSource === 'legacy' ? 'legacy' : 'env');
}
