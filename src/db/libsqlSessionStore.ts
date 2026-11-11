import crypto from 'node:crypto';
import session from 'express-session';
import type { SessionData } from 'express-session';
import type { DatabaseAdapter } from './contracts';

type WriteCallback = (error?: unknown) => void;
type ReadCallback = (error: unknown, data?: SessionData | null) => void;

interface SessionRow {
  ciphertext: string;
  expires_at: number;
}

export interface LibsqlSessionStoreOptions {
  adapter: DatabaseAdapter;
  secret: string;
  maxAgeMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Persistent shared Admin sessions for the future libSQL runtime.
 * The P3 store must be initialized explicitly before the first request.
 * No Vercel deployment profile is activated by this class.
 */
export class LibsqlSessionStore extends session.Store {
  private readonly adapter: DatabaseAdapter;
  private readonly encryptionKey: Buffer;
  private readonly sidKey: Buffer;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private initialized = false;

  constructor({
    adapter,
    secret,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    now = Date.now,
  }: LibsqlSessionStoreOptions) {
    super();
    if (adapter.kind !== 'libsql') throw new Error('LibsqlSessionStore requires a libSQL adapter.');
    if (typeof secret !== 'string' || secret.length < 32)
      throw new Error(
        'LibsqlSessionStore requires a stable SESSION_SECRET of at least 32 characters.',
      );
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0)
      throw new TypeError('Invalid session maximum age.');
    this.adapter = adapter;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.encryptionKey = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(secret, 'utf8'),
        Buffer.from('mcp_worker/libsql-admin-sessions/v1'),
        Buffer.from('aes-256-gcm-encryption'),
        32,
      ),
    );
    this.sidKey = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(secret, 'utf8'),
        Buffer.from('mcp_worker/libsql-admin-sessions/v1'),
        Buffer.from('session-id-hmac'),
        32,
      ),
    );
  }

  /** Must be called exactly as part of boot, before HTTP is served. */
  async initialize(): Promise<void> {
    await this.adapter.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (
      sid_hash TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    await this.adapter.exec(
      'CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions (expires_at)',
    );
    this.initialized = true;
  }

  /**
   * Open an already-provisioned session table without running DDL.
   * Serverless HTTP cold starts must not initialize schemas on requests.
   * The explicit preview provisioning CLI is the only schema writer.
   */
  async verifyExisting(): Promise<void> {
    await this.adapter.queryAll(
      'SELECT sid_hash, ciphertext, expires_at, created_at, updated_at FROM admin_sessions LIMIT 0',
    );
    this.initialized = true;
  }

  private ready(): void {
    if (!this.initialized)
      throw new Error(
        'LibsqlSessionStore.initialize must complete before use; or verifyExisting must complete.',
      );
  }

  private sidHash(sid: string): string {
    return crypto.createHmac('sha256', this.sidKey).update(sid).digest('hex');
  }

  private expiry(sess: SessionData): number {
    const age = sess.cookie?.maxAge;
    const ttl = typeof age === 'number' && Number.isFinite(age) ? age : this.maxAgeMs;
    return Math.max(this.now(), this.now() + ttl);
  }

  private seal(data: SessionData, sidHash: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(sidHash));
    const content = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      content.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  private open(ciphertext: string, sidHash: string): SessionData {
    const parts = ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1')
      throw new Error('Invalid encrypted Admin session record.');
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16)
      throw new Error('Invalid encrypted Admin session record.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAAD(Buffer.from(sidHash));
    decipher.setAuthTag(tag);
    const json = Buffer.concat([
      decipher.update(Buffer.from(parts[2], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const data: unknown = JSON.parse(json);
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Invalid Admin session payload.');
    return data as SessionData;
  }

  override get(sid: string, cb: ReadCallback): void {
    try {
      this.ready();
      const sidHash = this.sidHash(sid);
      void this.adapter
        .queryOne<SessionRow>(
          'SELECT ciphertext, expires_at FROM admin_sessions WHERE sid_hash = ?',
          [sidHash],
        )
        .then((row) => {
          if (!row || Number(row.expires_at) <= this.now()) return cb(null, null);
          return cb(null, this.open(row.ciphertext, sidHash));
        })
        .catch((error: unknown) => cb(error));
    } catch (error) {
      cb(error);
    }
  }

  override set(sid: string, sess: SessionData, cb?: WriteCallback): void {
    try {
      this.ready();
      const sidHash = this.sidHash(sid);
      const now = this.now();
      const expiresAt = this.expiry(sess);
      const ciphertext = this.seal(sess, sidHash);
      void this.adapter
        .execute(
          `INSERT INTO admin_sessions (sid_hash, ciphertext, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(sid_hash) DO UPDATE SET
             ciphertext = excluded.ciphertext,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
          [sidHash, ciphertext, expiresAt, now, now],
        )
        .then(() => cb?.(null))
        .catch((error: unknown) => cb?.(error));
    } catch (error) {
      cb?.(error);
    }
  }

  override touch(sid: string, sess: SessionData, cb?: WriteCallback): void {
    try {
      this.ready();
      const now = this.now();
      void this.adapter
        .execute(
          `UPDATE admin_sessions SET expires_at = ?, updated_at = ?
           WHERE sid_hash = ? AND expires_at > ?`,
          [this.expiry(sess), now, this.sidHash(sid), now],
        )
        .then(() => cb?.(null))
        .catch((error: unknown) => cb?.(error));
    } catch (error) {
      cb?.(error);
    }
  }

  override destroy(sid: string, cb?: WriteCallback): void {
    try {
      this.ready();
      void this.adapter
        .execute('DELETE FROM admin_sessions WHERE sid_hash = ?', [this.sidHash(sid)])
        .then(() => cb?.(null))
        .catch((error: unknown) => cb?.(error));
    } catch (error) {
      cb?.(error);
    }
  }

  /** Bounded expired-session cleanup, safe to invoke from a background job. */
  async pruneExpired(maxRows = 250): Promise<number> {
    this.ready();
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000)
      throw new RangeError('Session cleanup limit must be between 1 and 1000.');
    const rows = await this.adapter.queryAll<{ sid_hash: string }>(
      'SELECT sid_hash FROM admin_sessions WHERE expires_at <= ? LIMIT ?',
      [this.now(), maxRows],
    );
    for (const row of rows) {
      await this.adapter.execute(
        'DELETE FROM admin_sessions WHERE sid_hash = ? AND expires_at <= ?',
        [row.sid_hash, this.now()],
      );
    }
    return rows.length;
  }

  close(): void {
    // Adapter lifecycle belongs to the deployment runtime, not sessions.
  }
}
