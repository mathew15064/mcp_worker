import { config } from 'dotenv';
config();
import path from 'node:path';
import crypto from 'node:crypto';

function getDatabasePath() {
  return path.resolve(process.cwd(), process.env.DATABASE_PATH || 'data/bot_report.sqlite');
}

let ephemeralDevSecret: string | null = null;
const INSECURE_DEFAULTS = new Set([
  'bot-report-default-secret',
  'change-this-to-a-secure-random-64-character-hex-string',
]);
function managedSecret(purpose: string, size: number): Buffer {
  if (process.env.MCP_PLATFORM !== 'vercel') throw new Error('Not a managed Vercel instance.');
  const key = String(process.env.MCP_SETUP_SECRET || '');
  if (key.length < 43 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw Object.assign(
      new Error('MCP_SETUP_SECRET must be a high-entropy random base64url key (43+ characters).'),
      { code: 'MCP_SETUP_SECRET_INVALID' },
    );
  }
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(key, 'utf8'),
      Buffer.from('mcp_worker-selfhost-v1', 'utf8'),
      Buffer.from(purpose, 'utf8'),
      size,
    ),
  );
}

function getSessionSecret() {
  if (process.env.MCP_PLATFORM === 'vercel') return managedSecret('session', 64).toString('hex');
  const secret = process.env.SESSION_SECRET;
  const production = (process.env.NODE_ENV || 'development') === 'production';
  if (production) {
    if (!secret || INSECURE_DEFAULTS.has(secret.trim()) || secret.trim().length < 32) {
      const error = Object.assign(
        new Error(
          '[CONFIGURATION_ERROR] SESSION_SECRET must be explicitly configured with at least 32 characters in production.',
        ),
        { code: 'INVALID_SESSION_SECRET' },
      );
      throw error;
    }
    return secret;
  }
  if (secret?.trim()) return secret;
  if (!ephemeralDevSecret) ephemeralDevSecret = crypto.randomBytes(32).toString('hex');
  return ephemeralDevSecret;
}

const env = {
  managedSecret,
  get PORT() {
    return parseInt(process.env.PORT || '3333', 10);
  },
  get HOST() {
    return process.env.HOST || '0.0.0.0';
  },
  get NODE_ENV() {
    return process.env.NODE_ENV || 'development';
  },
  get SESSION_SECRET() {
    return getSessionSecret();
  },
  get DATABASE_PATH() {
    return getDatabasePath();
  },
  get ADMIN_USERNAME() {
    return process.env.ADMIN_USERNAME || 'admin';
  },
  get ADMIN_PASSWORD() {
    return process.env.ADMIN_PASSWORD || '';
  },
  get LOGIN_RATE_LIMIT_WINDOW_MS() {
    const value = parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || '', 10);
    return Number.isFinite(value) && value > 0 ? value : 15 * 60 * 1000;
  },
  get LOGIN_RATE_LIMIT_MAX() {
    const value = parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '', 10);
    return Number.isFinite(value) && value > 0 ? value : 5;
  },
  get TRUST_PROXY() {
    if (process.env.TRUST_PROXY === 'true') return true;
    if (process.env.TRUST_PROXY === 'false') return false;
    if (process.env.TRUST_PROXY !== undefined) {
      const numeric = Number(process.env.TRUST_PROXY);
      return Number.isNaN(numeric) ? process.env.TRUST_PROXY : numeric;
    }
    return (process.env.NODE_ENV || 'development') === 'production' ? 1 : false;
  },
};

export = env;
