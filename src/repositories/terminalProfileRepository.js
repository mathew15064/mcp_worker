const net = require('net');
const crypto = require('crypto');
const databaseManager = require('../db/databaseManager');
const { SqliteAdapter } = require('../db/adapters/sqliteAdapter');

const TMUX_SESSION_RE = /^[A-Za-z0-9_.-]{1,80}$/;

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateProfileInput(input) {
  if (!input || typeof input !== 'object') throw validationError('INVALID_PROFILE', 'Invalid profile.');
  const value = {
    name: typeof input.name === 'string' ? input.name.trim() : '',
    description: typeof input.description === 'string' ? input.description.trim() : '',
    host: typeof input.host === 'string' ? input.host.trim() : '',
    port: typeof input.port === 'number' || (typeof input.port === 'string' && /^\d+$/.test(input.port)) ? Number(input.port) : NaN,
    username: typeof input.username === 'string' ? input.username.trim() : '',
    tmux_session: typeof input.tmux_session === 'string' ? input.tmux_session : '',
    enabled: input.enabled === true || input.enabled === 1 || input.enabled === '1' || input.enabled === 'true' || input.enabled === 'on'
  };
  if (!value.name || value.name.length > 100) throw validationError('PROFILE_NAME_REQUIRED', 'Name is required and must be at most 100 characters.');
  if (value.description.length > 500) throw validationError('INVALID_DESCRIPTION', 'Description must be at most 500 characters.');
  if (!value.host || value.host.length > 255 || !(net.isIP(value.host) || /^(?=.{1,253}\.?$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/.test(value.host))) throw validationError('INVALID_HOST', 'Host is required and must be at most 255 characters.');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw validationError('INVALID_PORT', 'Port must be an integer from 1 to 65535.');
  if (!value.username || value.username.length > 100 || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(value.username)) throw validationError('INVALID_USERNAME', 'Username is required and must be at most 100 characters.');
  if (/[\x00-\x1f\x7f]/.test(value.host + value.username + value.name)) throw validationError('INVALID_PROFILE', 'Control characters are not allowed.');
  if (!TMUX_SESSION_RE.test(value.tmux_session)) throw validationError('INVALID_TMUX_SESSION', 'tmux session may contain only letters, numbers, underscore, dot, and hyphen.');
  return value;
}

class TerminalProfileRepository {
  constructor(db = null) { this._db = db && typeof db.prepare === 'function' ? new SqliteAdapter(db) : db; }
  get db() { return this._db || databaseManager.requireAdapter(); }

  async findAll() {
    const rows = await this.db.queryAll(`SELECT id, name, description, host, port, username,
      tmux_session, enabled, created_at, updated_at FROM terminal_profiles ORDER BY LOWER(name), name`);
    return rows.map(row => ({ ...row, enabled: Boolean(row.enabled) }));
  }

  async findById(id) {
    const row = await this.db.queryOne(`SELECT id, name, description, host, port, username,
      tmux_session, enabled, created_at, updated_at FROM terminal_profiles WHERE id = ?`, [id]);
    return row ? { ...row, enabled: Boolean(row.enabled) } : null;
  }

  async findWithCredentialById(id) {
    const row = await this.db.queryOne(`SELECT id, name, description, host, port, username, credential_envelope,
      host_key_fingerprint, tmux_session, enabled, created_at, updated_at FROM terminal_profiles WHERE id = ?`, [id]);
    return row ? { ...row, enabled: Boolean(row.enabled) } : null;
  }

  async findByNameCaseInsensitive(name) {
    if (typeof name !== 'string' || !name.trim()) return null;
    return this.db.queryOne('SELECT id, name FROM terminal_profiles WHERE LOWER(name) = LOWER(?) LIMIT 1', [name.trim()]);
  }

  async assertNameAvailable(name, excludeId = null) {
    const existing = await this.findByNameCaseInsensitive(name);
    if (existing && existing.id !== excludeId) throw validationError('PROFILE_NAME_CONFLICT', 'A Terminal Profile with this name already exists (case-insensitive).');
  }

  async create(input, credentialEnvelope) {
    const value = validateProfileInput(input);
    await this.assertNameAvailable(value.name);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await this.db.execute(`INSERT INTO terminal_profiles
        (id, name, description, host, port, username, credential_envelope, tmux_session, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, value.name, value.description || null, value.host, value.port,
        value.username, credentialEnvelope, value.tmux_session, value.enabled ? 1 : 0, now, now]);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'DB_UNIQUE_CONSTRAINT') throw validationError('PROFILE_NAME_CONFLICT', 'A Terminal Profile with this name already exists.');
      throw error;
    }
    return this.findById(id);
  }

  async update(id, input, credentialEnvelope = null) {
    const existing = await this.findById(id);
    if (!existing) throw validationError('PROFILE_NOT_FOUND', 'Terminal Profile not found.');
    const value = validateProfileInput(input);
    await this.assertNameAvailable(value.name, id);
    const now = new Date().toISOString();
    const credentialSql = credentialEnvelope ? ', credential_envelope = ?' : '';
    const params = [value.name, value.description || null, value.host, value.port, value.username,
      value.tmux_session, value.enabled ? 1 : 0, now];
    if (credentialEnvelope) params.push(credentialEnvelope);
    params.push(id);
    try {
      const result = await this.db.execute(`UPDATE terminal_profiles SET name = ?, description = ?, host = ?, port = ?,
        username = ?, tmux_session = ?, enabled = ?, updated_at = ? ${credentialSql} WHERE id = ?`, params);
      if (!result.changes) throw validationError('PROFILE_NOT_FOUND', 'Terminal Profile not found.');
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'DB_UNIQUE_CONSTRAINT') throw validationError('PROFILE_NAME_CONFLICT', 'A Terminal Profile with this name already exists.');
      throw error;
    }
    return this.findById(id);
  }

  async delete(id) { return (await this.db.execute('DELETE FROM terminal_profiles WHERE id = ?', [id])).changes > 0; }
}

module.exports = new TerminalProfileRepository();
module.exports.TerminalProfileRepository = TerminalProfileRepository;
module.exports.validateProfileInput = validateProfileInput;
module.exports.TMUX_SESSION_RE = TMUX_SESSION_RE;
