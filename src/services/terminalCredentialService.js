const crypto = require('crypto');

const AAD = Buffer.from('bot_report:terminal-credential:v1', 'utf8');

function credentialError(message) {
  const error = new Error(message);
  error.code = 'CREDENTIAL_DECRYPT_FAILED';
  return error;
}

function readKey() {
  const encoded = process.env.APP_ENCRYPTION_KEY || process.env.TERMINAL_CREDENTIAL_KEY;
  if (!encoded) throw credentialError('Application credential encryption is not configured.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encoded.trim().replace(/=+$/, '')) {
    throw credentialError('Terminal credential encryption key is invalid.');
  }
  return key;
}

function encrypt(password) {
  if (typeof password !== 'string' || password.length === 0 || Buffer.byteLength(password) > 4096) {
    const error = new Error('Password is required.');
    error.code = 'PASSWORD_REQUIRED';
    throw error;
  }
  const key = readKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

function decrypt(envelope) {
  try {
    const key = readKey();
    const parts = typeof envelope === 'string' ? envelope.split(':') : [];
    if (parts.length !== 4 || parts[0] !== 'v1') throw credentialError('Credential envelope is invalid.');
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw credentialError('Credential envelope is invalid.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error.code === 'CREDENTIAL_DECRYPT_FAILED') throw error;
    throw credentialError('Stored terminal credential could not be decrypted.');
  }
}

// Verify GCM authenticity before reusing an envelope. Do not decode a password
// string or re-encrypt: the original encrypted bytes are inherited unchanged.
function validateForCopy(envelope) {
  try {
    const key = readKey();
    const parts = typeof envelope === 'string' && envelope.length <= 6000 ? envelope.split(':') : [];
    if (parts.length !== 4 || parts[0] !== 'v1') throw credentialError('Credential envelope is invalid.');
    const buffers = parts.slice(1).map(part => Buffer.from(part, 'base64url'));
    const [iv, tag, ciphertext] = buffers;
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1 || ciphertext.length > 4096 ||
        buffers.some((buffer, index) => buffer.toString('base64url') !== parts[index + 1])) {
      throw credentialError('Credential envelope is invalid.');
    }
    const verifier = crypto.createDecipheriv('aes-256-gcm', key, iv);
    verifier.setAAD(AAD);
    verifier.setAuthTag(tag);
    // Node's GCM API verifies the tag at final(). Its transient output is wiped
    // immediately and never converted to a string, returned, logged or stored.
    verifier.update(ciphertext).fill(0);
    verifier.final().fill(0);
  } catch (_) {
    throw credentialError('Stored terminal credential could not be authenticated.');
  }
}

module.exports = { encrypt, decrypt, validateForCopy };
