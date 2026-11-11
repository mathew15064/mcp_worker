interface ProfileInput { name?: unknown; description?: unknown; workerId?: unknown; worker_id?: unknown; enabled?: unknown }
interface WorkerRow { id: string; name: string; public_key: string; capabilities_json: string | null; enabled: number | boolean; status: string; owner_user_id: string | null; last_seen_at: string | null }
interface ProfileRow { id: string; name: string; worker_id: string; enabled: number | boolean; worker_enabled?: number | boolean; owner_user_id?: string | null }
interface OwnerOptions { ownerUserId?: string | null }
import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/contracts';
const databaseManager: { requireAdapter(): DatabaseAdapter } = require('../db/databaseManager');

function workerError(code: string, message: string, status = 400) { return Object.assign(new Error(message), {code, status}); }

function parseJsonArray(value: string | null): unknown[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeWorkerName(name: unknown) {
  const normalized = String(name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/.test(normalized)) {
    throw workerError('WORKER_NAME_INVALID', 'Worker name must be 1-100 safe characters.');
  }
  return normalized;
}

function normalizeProfileInput(input: ProfileInput = {}) {
  const value = {
    name: String(input.name || '').trim(),
    description: String(input.description || '').trim(),
    workerId: String(input.workerId || input.worker_id || '').trim(),
    enabled: input.enabled === true || input.enabled === 1 || input.enabled === '1' || input.enabled === 'true' || input.enabled === 'on'
  };
  if (!value.name || value.name.length > 100 || /[\x00-\x1f\x7f]/.test(value.name)) throw workerError('WORKER_PROFILE_NAME_INVALID', 'Worker profile name must be 1-100 safe characters.');
  if (value.description.length > 500) throw workerError('WORKER_PROFILE_DESCRIPTION_INVALID', 'Worker profile description must be at most 500 characters.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.workerId)) throw workerError('WORKER_PROFILE_WORKER_INVALID', 'Worker identity is invalid.');
  return value;
}

class WorkerRepository {
  constructor(private _adapter: DatabaseAdapter | null = null) {
  }

  get db() {
    return this._adapter || databaseManager.requireAdapter();
  }

  hydrateWorker(row: WorkerRow | null) {
    if (!row) return null;
    return {
      ...row,
      capabilities: parseJsonArray(row.capabilities_json),
      enabled: Boolean(row.enabled)
    };
  }

  hydrateProfile(row: ProfileRow | null) {
    if (!row) return null;
    return {
      ...row,
      transport: 'worker',
      enabled: Boolean(row.enabled) && (row.worker_enabled === undefined ? true : Boolean(row.worker_enabled))
    };
  }

  async createEnrollmentToken({ ttlSeconds = 600, ownerUserId = null }: OwnerOptions & {ttlSeconds?: number} = {}) {
    const ttl = Math.max(60, Math.min(Number(ttlSeconds) || 600, 3600));
    const rawToken = `br_enroll_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const now = new Date();
    const id = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    await this.db.execute(`INSERT INTO worker_enrollment_tokens
      (id, token_hash, owner_user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)`,
    [id, tokenHash, ownerUserId || null, expiresAt, now.toISOString()]);
    return { id, token: rawToken, owner_user_id: ownerUserId || null, expires_at: expiresAt };
  }

  async consumeEnrollmentToken(rawToken: string) {
    if (typeof rawToken !== 'string' || !rawToken.startsWith('br_enroll_')) {
      throw workerError('WORKER_ENROLLMENT_INVALID', 'Invalid worker enrollment token.', 401);
    }
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    return this.db.transaction(async tx => {
      const row = await tx.queryOne<{id: string; owner_user_id: string | null; expires_at: string; used_at: string | null}>('SELECT id, owner_user_id, expires_at, used_at FROM worker_enrollment_tokens WHERE token_hash = ?', [tokenHash]);
      if (!row || row.used_at) throw workerError('WORKER_ENROLLMENT_INVALID', 'Invalid or already used worker enrollment token.', 401);
      if (Date.parse(row.expires_at) <= Date.now()) throw workerError('WORKER_ENROLLMENT_EXPIRED', 'Worker enrollment token has expired.', 401);
      const usedAt = new Date().toISOString();
      const updated = await tx.execute('UPDATE worker_enrollment_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', [usedAt, row.id]);
      if (updated.changes !== 1) throw workerError('WORKER_ENROLLMENT_INVALID', 'Worker enrollment token was already consumed.', 401);
      return { id: row.id, owner_user_id: row.owner_user_id || null, used_at: usedAt };
    });
  }

  async createWorker({ name, publicKey, capabilities = [], ownerUserId = null }: OwnerOptions & {name: string; publicKey: string; capabilities?: unknown[]}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await this.db.execute(`INSERT INTO workers
        (id, name, public_key, capabilities_json, owner_user_id, enabled, status, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, 'offline', NULL, ?, ?)`,
      [id, name, publicKey, JSON.stringify(capabilities), ownerUserId || null, now, now]);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'DB_UNIQUE_CONSTRAINT' || error.code === 'SQLITE_CONSTRAINT_UNIQUE')) {
        throw workerError('WORKER_NAME_CONFLICT', 'A worker with this name already exists.', 409);
      }
      throw error;
    }
    return this.findWorkerById(id);
  }

  async findWorkerById(id: string) {
    return this.hydrateWorker(await this.db.queryOne<WorkerRow>('SELECT * FROM workers WHERE id = ?', [id]));
  }

  async findWorkerByIdForOwner(id: string, ownerUserId: string) {
    return this.hydrateWorker(await this.db.queryOne<WorkerRow>('SELECT * FROM workers WHERE id = ? AND owner_user_id = ?', [id, ownerUserId]));
  }

  async findAdminWorkerById(id: string) {
    return this.hydrateWorker(await this.db.queryOne<WorkerRow>('SELECT * FROM workers WHERE id = ? AND owner_user_id IS NULL', [id]));
  }

  async findWorkerByName(name: string) {
    return this.hydrateWorker(await this.db.queryOne<WorkerRow>('SELECT * FROM workers WHERE LOWER(name) = LOWER(?) LIMIT 1', [String(name || '').trim()]));
  }

  async listWorkers() {
    return (await this.db.queryAll<WorkerRow>(`SELECT w.*, u.username AS owner_username, u.display_name AS owner_display_name
      FROM workers w LEFT JOIN users u ON u.id = w.owner_user_id ORDER BY LOWER(w.name), w.name`)).map(row => this.hydrateWorker(row));
  }

  async listWorkersByOwner(ownerUserId: string) {
    return (await this.db.queryAll<WorkerRow>(`SELECT w.*, u.username AS owner_username, u.display_name AS owner_display_name
      FROM workers w LEFT JOIN users u ON u.id = w.owner_user_id WHERE w.owner_user_id = ? ORDER BY LOWER(w.name), w.name`, [ownerUserId])).map(row => this.hydrateWorker(row));
  }

  async listAdminWorkers() {
    return (await this.db.queryAll<WorkerRow>(`SELECT w.*, NULL AS owner_username, NULL AS owner_display_name
      FROM workers w WHERE w.owner_user_id IS NULL ORDER BY LOWER(w.name), w.name`)).map(row => this.hydrateWorker(row));
  }

  async updateWorkerName(id: string, name: string, { ownerUserId = null }: OwnerOptions = {}) {
    const normalized = normalizeWorkerName(name);
    const now = new Date().toISOString();
    const params = [normalized, now, id];
    const ownerClause = ownerUserId ? ' AND owner_user_id = ?' : '';
    if (ownerUserId) params.push(ownerUserId);
    try {
      const result = await this.db.execute(`UPDATE workers SET name = ?, updated_at = ? WHERE id = ?${ownerClause}`, params);
      if (!result.changes) throw workerError('WORKER_NOT_FOUND', 'Worker not found.', 404);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'DB_UNIQUE_CONSTRAINT' || error.code === 'SQLITE_CONSTRAINT_UNIQUE')) {
        throw workerError('WORKER_NAME_CONFLICT', 'A worker with this name already exists.', 409);
      }
      throw error;
    }
    return ownerUserId ? this.findWorkerByIdForOwner(id, ownerUserId) : this.findWorkerById(id);
  }

  async setWorkerEnabled(id: string, enabled: boolean, { ownerUserId = null }: OwnerOptions = {}) {
    const now = new Date().toISOString();
    const params = [enabled ? 1 : 0, enabled ? 1 : 0, now, id];
    const ownerClause = ownerUserId ? ' AND owner_user_id = ?' : '';
    if (ownerUserId) params.push(ownerUserId);
    const result = await this.db.execute(`UPDATE workers SET enabled = ?, status = CASE WHEN ? = 1 THEN status ELSE 'offline' END,
      updated_at = ? WHERE id = ?${ownerClause}`, params);
    if (!result.changes) throw workerError('WORKER_NOT_FOUND', 'Worker not found.', 404);
    return ownerUserId ? this.findWorkerByIdForOwner(id, ownerUserId) : this.findWorkerById(id);
  }

  async deleteWorker(id: string, { ownerUserId = null }: OwnerOptions = {}) {
    const params = [id];
    const ownerClause = ownerUserId ? ' AND owner_user_id = ?' : '';
    if (ownerUserId) params.push(ownerUserId);
    return (await this.db.execute(`DELETE FROM workers WHERE id = ?${ownerClause}`, params)).changes > 0;
  }

  async updateWorkerPresence(id: string, status: string, { lastSeenAt = new Date().toISOString() } = {}) {
    const normalized = status === 'online' ? 'online' : 'offline';
    await this.db.execute('UPDATE workers SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?',
      [normalized, lastSeenAt, lastSeenAt, id]);
  }

  async touchWorker(id: string) {
    const now = new Date().toISOString();
    await this.db.execute("UPDATE workers SET status = 'online', last_seen_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
  }

  async updateWorkerCapabilities(id: string, capabilities: unknown[] = []) {
    const now = new Date().toISOString();
    await this.db.execute('UPDATE workers SET capabilities_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(capabilities), now, id]);
  }

  async createProfile(input: ProfileInput, { ownerUserId = null }: OwnerOptions = {}) {
    const value = normalizeProfileInput(input);
    const worker = ownerUserId ? await this.findWorkerByIdForOwner(value.workerId, ownerUserId) : await this.findWorkerById(value.workerId);
    if (!worker) throw workerError('WORKER_NOT_FOUND', 'Worker not found.', 404);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await this.db.execute(`INSERT INTO worker_profiles
        (id, name, description, worker_id, tmux_session, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, value.name, value.description || null, value.workerId, '', value.enabled ? 1 : 0, now, now]);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'DB_UNIQUE_CONSTRAINT' || error.code === 'SQLITE_CONSTRAINT_UNIQUE')) {
        throw workerError('WORKER_PROFILE_NAME_CONFLICT', 'A worker profile with this name already exists.', 409);
      }
      throw error;
    }
    return this.findProfileById(id);
  }

  async findProfileById(id: string) {
    return this.hydrateProfile(await this.db.queryOne<ProfileRow>(`SELECT p.*, w.name AS worker_name, w.status AS worker_status, w.enabled AS worker_enabled,
      w.last_seen_at AS worker_last_seen_at, w.owner_user_id FROM worker_profiles p JOIN workers w ON w.id = p.worker_id WHERE p.id = ?`, [id]));
  }

  async findProfileByIdForOwner(id: string, ownerUserId: string) {
    return this.hydrateProfile(await this.db.queryOne<ProfileRow>(`SELECT p.*, w.name AS worker_name, w.status AS worker_status, w.enabled AS worker_enabled,
      w.last_seen_at AS worker_last_seen_at, w.owner_user_id FROM worker_profiles p JOIN workers w ON w.id = p.worker_id
      WHERE p.id = ? AND w.owner_user_id = ?`, [id, ownerUserId]));
  }

  async findAdminProfileById(id: string) {
    return this.hydrateProfile(await this.db.queryOne<ProfileRow>(`SELECT p.*, w.name AS worker_name, w.status AS worker_status, w.enabled AS worker_enabled,
      w.last_seen_at AS worker_last_seen_at, w.owner_user_id FROM worker_profiles p JOIN workers w ON w.id = p.worker_id
      WHERE p.id = ? AND w.owner_user_id IS NULL`, [id]));
  }

  async findProfileByName(name: string) {
    return this.hydrateProfile(await this.db.queryOne<ProfileRow>(`SELECT p.*, w.name AS worker_name, w.status AS worker_status, w.enabled AS worker_enabled,
      w.last_seen_at AS worker_last_seen_at, w.owner_user_id FROM worker_profiles p JOIN workers w ON w.id = p.worker_id
      WHERE LOWER(p.name) = LOWER(?) LIMIT 1`, [String(name || '').trim()]));
  }

  async listProfiles() {
    return (await this.db.queryAll<ProfileRow>(`SELECT p.*, w.name AS worker_name, w.status AS worker_status, w.enabled AS worker_enabled,
      w.last_seen_at AS worker_last_seen_at, w.owner_user_id FROM worker_profiles p JOIN workers w ON w.id = p.worker_id
      ORDER BY LOWER(p.name), p.name`)).map(row => this.hydrateProfile(row));
  }

  async listProfilesByOwner(ownerUserId: string) {
    return (await this.db.queryAll<ProfileRow>(`SELECT p.*, w.name AS worker_name, w.status AS worker_status, w.enabled AS worker_enabled,
      w.last_seen_at AS worker_last_seen_at, w.owner_user_id FROM worker_profiles p JOIN workers w ON w.id = p.worker_id
      WHERE w.owner_user_id = ? ORDER BY LOWER(p.name), p.name`, [ownerUserId])).map(row => this.hydrateProfile(row));
  }

  async listAdminProfiles() {
    return (await this.db.queryAll<ProfileRow>(`SELECT p.*, w.name AS worker_name, w.status AS worker_status, w.enabled AS worker_enabled,
      w.last_seen_at AS worker_last_seen_at, w.owner_user_id FROM worker_profiles p JOIN workers w ON w.id = p.worker_id
      WHERE w.owner_user_id IS NULL ORDER BY LOWER(p.name), p.name`)).map(row => this.hydrateProfile(row));
  }

  async updateProfile(id: string, input: ProfileInput, { ownerUserId = null }: OwnerOptions = {}) {
    const value = normalizeProfileInput(input);
    const existing = ownerUserId ? await this.findProfileByIdForOwner(id, ownerUserId) : await this.findProfileById(id);
    if (!existing) throw workerError('WORKER_PROFILE_NOT_FOUND', 'Worker profile not found.', 404);
    const worker = ownerUserId ? await this.findWorkerByIdForOwner(value.workerId, ownerUserId) : await this.findWorkerById(value.workerId);
    if (!worker) throw workerError('WORKER_NOT_FOUND', 'Worker not found.', 404);
    const now = new Date().toISOString();
    const result = await this.db.execute(`UPDATE worker_profiles SET name = ?, description = ?, worker_id = ?,
      tmux_session = '', enabled = ?, updated_at = ? WHERE id = ?`,
    [value.name, value.description || null, value.workerId, value.enabled ? 1 : 0, now, id]);
    if (!result.changes) throw workerError('WORKER_PROFILE_NOT_FOUND', 'Worker profile not found.', 404);
    return ownerUserId ? this.findProfileByIdForOwner(id, ownerUserId) : this.findProfileById(id);
  }

  async deleteProfile(id: string, { ownerUserId = null }: OwnerOptions = {}) {
    if (!ownerUserId) return (await this.db.execute('DELETE FROM worker_profiles WHERE id = ?', [id])).changes > 0;
    return (await this.db.execute(`DELETE FROM worker_profiles WHERE id = ? AND worker_id IN
      (SELECT id FROM workers WHERE owner_user_id = ?)`, [id, ownerUserId])).changes > 0;
  }
}

const instance = Object.assign(new WorkerRepository(), {WorkerRepository, workerError, normalizeProfileInput, normalizeWorkerName});
export = instance;
