import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { DatabaseAdapter } from '../db/contracts';

const CLAIM_KEY = 'primary';
const OWNER_ID = 'preview-owner';
const OWNER_PRINCIPAL = 'principal:owner';
const USERNAME = /^[A-Za-z0-9_.-]{3,64}$/;

export class PreviewOwnerClaimError extends Error {
  constructor(
    readonly code:
      | 'OWNER_CLAIM_CONFIGURATION_INVALID'
      | 'OWNER_CLAIM_DENIED'
      | 'OWNER_CLAIM_INVALID_INPUT'
      | 'OWNER_ALREADY_CLAIMED',
  ) {
    super(code);
    this.name = 'PreviewOwnerClaimError';
  }
}

interface OwnerRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  session_version: number;
}

export interface PreviewOwnerSession {
  userId?: string;
  role?: string;
  sessionVersion?: number;
  authSource?: string;
}

export interface PreviewOwnerIdentity {
  id: string;
  username: string;
  role: 'admin';
  session_version: number;
  auth_source: 'libsql-preview';
}

/**
 * Schema creation is limited to the explicit disposable-preview CLI.
 * HTTP runtime startup must use verifyExisting() instead.
 */
export async function initializePreviewOwnerClaimSchema(adapter: DatabaseAdapter): Promise<void> {
  if (adapter.kind !== 'libsql')
    throw new PreviewOwnerClaimError('OWNER_CLAIM_CONFIGURATION_INVALID');
  await adapter.exec(`CREATE TABLE IF NOT EXISTS preview_owner_claims (
    claim_key TEXT PRIMARY KEY NOT NULL CHECK (claim_key = 'primary'),
    owner_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    claimed_at TEXT NOT NULL
  )`);
}

/**
 * Single-owner bootstrap independent of the legacy environment Admin.
 * This is a service only, NOT a public claim/login endpoint. A future
 * HTTPS handler must add origin/CSRF checks, rate limits, safe session
 * regeneration, and ownership proof before exposing this operation.
 */
export class PreviewOwnerClaimService {
  private readonly tokenDigest: Buffer;
  private verified = false;

  constructor(
    private readonly adapter: DatabaseAdapter,
    claimToken: string,
  ) {
    if (adapter.kind !== 'libsql' || typeof claimToken !== 'string' || claimToken.length < 32) {
      throw new PreviewOwnerClaimError('OWNER_CLAIM_CONFIGURATION_INVALID');
    }
    this.tokenDigest = crypto.createHash('sha256').update(claimToken).digest();
  }

  async verifyExisting(): Promise<void> {
    await this.adapter.queryAll(
      'SELECT claim_key, owner_user_id, claimed_at FROM preview_owner_claims LIMIT 0',
    );
    this.verified = true;
  }

  private ready(): void {
    if (!this.verified) throw new PreviewOwnerClaimError('OWNER_CLAIM_CONFIGURATION_INVALID');
  }

  private validProof(input: unknown): boolean {
    const value = typeof input === 'string' ? input : '';
    const actual = crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(actual, this.tokenDigest);
  }

  /**
   * Claim-once invariant enforced by one write transaction and primary-key
   * constraint. Never store the proof secret, password or session ID as plaintext.
   */
  async claim(input: {
    proof: unknown;
    username: unknown;
    password: unknown;
  }): Promise<PreviewOwnerIdentity> {
    this.ready();
    if (!this.validProof(input.proof)) throw new PreviewOwnerClaimError('OWNER_CLAIM_DENIED');
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    const password = input.password;
    if (
      !USERNAME.test(username) ||
      typeof password !== 'string' ||
      password.length < 12 ||
      password.length > 256
    ) {
      throw new PreviewOwnerClaimError('OWNER_CLAIM_INVALID_INPUT');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    return this.adapter.transaction(async (tx) => {
      const prior = await tx.queryOne(
        'SELECT owner_user_id FROM preview_owner_claims WHERE claim_key = ?',
        [CLAIM_KEY],
      );
      if (prior) throw new PreviewOwnerClaimError('OWNER_ALREADY_CLAIMED');
      const now = new Date().toISOString();
      await tx.execute(
        `INSERT INTO users (id, username, email, display_name, password_hash,
          role, status, principal_id, profile_id, session_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          OWNER_ID,
          username,
          null,
          username,
          passwordHash,
          'admin',
          'active',
          OWNER_PRINCIPAL,
          'profile:owner',
          1,
          now,
          now,
        ],
      );
      await tx.execute(
        'INSERT INTO preview_owner_claims (claim_key, owner_user_id, claimed_at) VALUES (?, ?, ?)',
        [CLAIM_KEY, OWNER_ID, now],
      );
      return {
        id: OWNER_ID,
        username,
        role: 'admin' as const,
        session_version: 1,
        auth_source: 'libsql-preview' as const,
      };
    });
  }

  private async owner(username?: string): Promise<OwnerRow | null> {
    this.ready();
    return this.adapter.queryOne<OwnerRow>(
      `SELECT u.id, u.username, u.password_hash, u.role, u.status, u.session_version
      FROM preview_owner_claims c JOIN users u ON u.id = c.owner_user_id
      WHERE c.claim_key = ?${username ? ' AND u.username = ?' : ''}`,
      username ? [CLAIM_KEY, username] : [CLAIM_KEY],
    );
  }

  private identity(row: OwnerRow): PreviewOwnerIdentity {
    return {
      id: row.id,
      username: row.username,
      role: 'admin',
      session_version: Number(row.session_version),
      auth_source: 'libsql-preview',
    };
  }

  /**
   * Password authentication and session identity validation are separate.
   * A public login endpoint is intentionally not provided in this milestone.
   */
  async authenticate(username: string, password: string): Promise<PreviewOwnerIdentity | null> {
    if (!username || !password) return null;
    const row = await this.owner(username);
    if (!row || row.role !== 'admin' || row.status !== 'active') return null;
    if (!(await bcrypt.compare(password, row.password_hash))) return null;
    return this.identity(row);
  }

  async currentIdentity(
    session: PreviewOwnerSession | null | undefined,
  ): Promise<PreviewOwnerIdentity | null> {
    if (
      !session ||
      session.role !== 'admin' ||
      session.userId !== OWNER_ID ||
      session.authSource !== 'libsql-preview'
    )
      return null;
    const row = await this.owner();
    if (!row || row.id !== session.userId || row.role !== 'admin' || row.status !== 'active')
      return null;
    if (Number(session.sessionVersion) !== Number(row.session_version)) return null;
    return this.identity(row);
  }
}
