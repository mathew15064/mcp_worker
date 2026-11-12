import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import telegramSecrets from '../src/services/telegramSecretService';

void test('Telegram token envelope retains AES-256-GCM authentication and confidentiality', () => {
  const previous = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  try {
    const encrypted = telegramSecrets.encrypt('test-bot-token');
    assert.match(encrypted, /^enc:v3:/);
    assert.equal(telegramSecrets.decrypt(encrypted), 'test-bot-token');
    assert.doesNotMatch(encrypted, /test-bot-token/);
    assert.throws(() => telegramSecrets.decrypt(encrypted.slice(0, -3) + 'AAA'));
  } finally {
    if (previous === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previous;
  }
});
