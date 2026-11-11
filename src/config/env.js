require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

function getDatabasePath() {
  return path.resolve(process.cwd(), process.env.DATABASE_PATH || 'data/bot_report.sqlite');
}

let ephemeralDevSecret = null;
const INSECURE_DEFAULTS = new Set(['bot-report-default-secret', 'change-this-to-a-secure-random-64-character-hex-string']);
function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  const production = (process.env.NODE_ENV || 'development') === 'production';
  if (production) {
    if (!secret || INSECURE_DEFAULTS.has(secret.trim()) || secret.trim().length < 32) {
      const error = new Error('[CONFIGURATION_ERROR] SESSION_SECRET must be explicitly configured with at least 32 characters in production.');
      error.code = 'INVALID_SESSION_SECRET';
      throw error;
    }
    return secret;
  }
  if (secret?.trim()) return secret;
  if (!ephemeralDevSecret) ephemeralDevSecret = crypto.randomBytes(32).toString('hex');
  return ephemeralDevSecret;
}

module.exports = {
  get PORT() { return parseInt(process.env.PORT || '3333', 10); },
  get HOST() { return process.env.HOST || '0.0.0.0'; },
  get NODE_ENV() { return process.env.NODE_ENV || 'development'; },
  get SESSION_SECRET() { return getSessionSecret(); },
  get DATABASE_PATH() { return getDatabasePath(); },
  get ADMIN_USERNAME() { return process.env.ADMIN_USERNAME || 'admin'; },
  get ADMIN_PASSWORD() { return process.env.ADMIN_PASSWORD || ''; },
  get LOGIN_RATE_LIMIT_WINDOW_MS() {
    const value = parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 10);
    return Number.isFinite(value) && value > 0 ? value : 15 * 60 * 1000;
  },
  get LOGIN_RATE_LIMIT_MAX() {
    const value = parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10);
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
  }
};
