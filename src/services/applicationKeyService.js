const crypto = require('crypto');

function keyError(message) {
  const error = new Error(message);
  error.code = 'APPLICATION_KEY_INVALID';
  return error;
}

function readKey() {
  const encoded = process.env.APP_ENCRYPTION_KEY || process.env.TERMINAL_CREDENTIAL_KEY;
  if (!encoded) throw keyError('Application encryption key is not configured.');
  const trimmed = encoded.trim();
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
    throw keyError('Application encryption key must be a valid base64 encoded 32-byte key.');
  }
  return key;
}

function encryptString(value, aad, version = 'enc:v1') {
  if (typeof value !== 'string' || !value.length) throw keyError('Secret value is required.');
  const key = readKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

function decryptString(envelope, aad, version = 'enc:v1') {
  try {
    const key = readKey();
    const prefix = `${version}:`;
    if (typeof envelope !== 'string' || !envelope.startsWith(prefix)) throw keyError('Encrypted value has an invalid envelope.');
    const parts = envelope.slice(prefix.length).split(':');
    if (parts.length !== 3) throw keyError('Encrypted value has an invalid envelope.');
    const [ivPart, tagPart, ciphertextPart] = parts;
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) throw keyError('Encrypted value has an invalid envelope.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error?.code === 'APPLICATION_KEY_INVALID') throw error;
    throw keyError('Encrypted value could not be decrypted.');
  }
}

module.exports = { readKey, encryptString, decryptString, keyError };
