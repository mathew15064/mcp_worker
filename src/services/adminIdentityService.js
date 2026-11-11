const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const config = require('../config/env');

const ADMIN_ID = 'env-admin';
const SESSION_VERSION = 1;

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function identity(authSource = 'env') {
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

function envAuthenticate(username, password) {
  const configuredPassword = config.ADMIN_PASSWORD;
  if (!configuredPassword || configuredPassword.trim().length < 8) {
    const error = new Error('ADMIN_PASSWORD must be configured with at least 8 characters.');
    error.code = 'ADMIN_PASSWORD_INVALID';
    throw error;
  }
  return timingSafeStringEqual(String(username || ''), config.ADMIN_USERNAME)
    && timingSafeStringEqual(String(password || ''), configuredPassword);
}

function legacyAuthenticate(username, password) {
  const databaseManager = require('../db/databaseManager');
  if (databaseManager.status().state !== 'MIGRATION_REQUIRED' || !databaseManager.legacyAvailable()) return false;
  let db = null;
  try {
    db = new Database(config.DATABASE_PATH, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT username, password_hash FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get();
    if (!row || !timingSafeStringEqual(String(username || ''), String(row.username || ''))) return false;
    return bcrypt.compareSync(String(password || ''), String(row.password_hash || ''));
  } catch (_) {
    return false;
  } finally {
    try { db?.close(); } catch (_) {}
  }
}

function authenticate(username, password) {
  if (envAuthenticate(username, password)) return identity('env');
  if (legacyAuthenticate(username, password)) return identity('legacy');
  return null;
}

function currentFromSession(session) {
  if (!session || session.userId !== ADMIN_ID || session.role !== 'admin') return null;
  if ((session.sessionVersion || SESSION_VERSION) !== SESSION_VERSION) return null;
  return identity(session.authSource === 'legacy' ? 'legacy' : 'env');
}

module.exports = { ADMIN_ID, SESSION_VERSION, identity, authenticate, currentFromSession, timingSafeStringEqual };
