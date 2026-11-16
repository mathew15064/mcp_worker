import { stringifyUnknown } from '../utils/stringifyUnknown';
import crypto from 'node:crypto';
import config from '../config/env';
interface AdminSession {
  userId?: string;
  role?: string;
  sessionVersion?: number;
  authSource?: string;
}

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
    updated_at: null,
  };
}

function envAuthenticate(username: unknown, password: unknown) {
  const configuredPassword = config.ADMIN_PASSWORD;
  if (!configuredPassword || configuredPassword.trim().length < 8) {
    const error = Object.assign(
      new Error('ADMIN_PASSWORD must be configured with at least 8 characters.'),
      { code: 'ADMIN_PASSWORD_INVALID' },
    );
    throw error;
  }
  return (
    timingSafeStringEqual(stringifyUnknown(username || ''), config.ADMIN_USERNAME) &&
    timingSafeStringEqual(stringifyUnknown(password || ''), configuredPassword)
  );
}

export function authenticate(username: unknown, password: unknown) {
  if (envAuthenticate(username, password)) return identity('env');
  return null;
}

export function currentFromSession(session: AdminSession | null | undefined) {
  if (!session || session.userId !== ADMIN_ID || session.role !== 'admin') return null;
  if ((session.sessionVersion || SESSION_VERSION) !== SESSION_VERSION) return null;
  return identity('env');
}
