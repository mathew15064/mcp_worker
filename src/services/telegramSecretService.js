const crypto = require('crypto');
const config = require('../config/env');

const LEGACY_V1_PREFIX = 'enc:v1';
const LEGACY_V2_PREFIX = 'enc:v2';
const PREFIX = 'enc:v3';
const LEGACY_V1_AAD = Buffer.from('bot_report:telegram-token:v1', 'utf8');
const LEGACY_V2_AAD = Buffer.from('bot_report:telegram-token:v2', 'utf8');
const AAD = Buffer.from('bot_report:telegram-token:v3', 'utf8');

function secretError(message) {
  const error = new Error(message);
  error.code = 'TELEGRAM_SECRET_DECRYPT_FAILED';
  return error;
}

function decodeKey(encoded, message) {
  if (!encoded) throw secretError(message);
  const normalized = encoded.trim();
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    throw secretError('Application credential encryption key is invalid.');
  }
  return key;
}

function readApplicationCredentialKey() {
  return decodeKey(
    process.env.APP_ENCRYPTION_KEY || process.env.TERMINAL_CREDENTIAL_KEY,
    'Application credential encryption requires APP_ENCRYPTION_KEY (or legacy TERMINAL_CREDENTIAL_KEY).'
  );
}

function readLegacyV2Key() {
  return decodeKey(
    process.env.TELEGRAM_CREDENTIAL_KEY || process.env.TERMINAL_CREDENTIAL_KEY,
    'Legacy Telegram token encryption key is unavailable.'
  );
}

function readLegacyV1Key() {
  const sessionSecret = config.SESSION_SECRET;
  if (!sessionSecret || typeof sessionSecret !== 'string') {
    throw secretError('Legacy Telegram token encryption key is unavailable.');
  }
  return crypto.createHash('sha256')
    .update('bot_report:telegram-key:v1\0', 'utf8')
    .update(sessionSecret, 'utf8')
    .digest();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:');
}

function needsMigration(value) {
  return typeof value === 'string' && Boolean(value.trim()) && !value.trim().startsWith(`${PREFIX}:`);
}

function encrypt(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw secretError('Telegram bot token is required.');
  }
  const plaintext = value.trim();
  if (Buffer.byteLength(plaintext, 'utf8') > 4096) {
    throw secretError('Telegram bot token is too large.');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', readApplicationCredentialKey(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

function decryptEnvelope(stored, prefix, key, aad) {
  const parts = stored.split(':');
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== prefix) {
    throw secretError('Stored Telegram token envelope is invalid.');
  }
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  const ciphertext = Buffer.from(parts[4], 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0 || ciphertext.length > 4096) {
    throw secretError('Stored Telegram token envelope is invalid.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decrypt(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const stored = value.trim();

  // Plaintext is accepted only for installations that predate encrypted settings.
  if (!stored.startsWith('enc:')) return stored;

  try {
    if (stored.startsWith(`${PREFIX}:`)) {
      return decryptEnvelope(stored, PREFIX, readApplicationCredentialKey(), AAD);
    }
    if (stored.startsWith(`${LEGACY_V2_PREFIX}:`)) {
      return decryptEnvelope(stored, LEGACY_V2_PREFIX, readLegacyV2Key(), LEGACY_V2_AAD);
    }
    if (stored.startsWith(`${LEGACY_V1_PREFIX}:`)) {
      return decryptEnvelope(stored, LEGACY_V1_PREFIX, readLegacyV1Key(), LEGACY_V1_AAD);
    }
    throw secretError('Stored Telegram token envelope version is unsupported.');
  } catch (error) {
    if (error.code === 'TELEGRAM_SECRET_DECRYPT_FAILED') throw error;
    throw secretError('Stored Telegram token could not be decrypted.');
  }
}

module.exports = { encrypt, decrypt, isEncrypted, needsMigration };
