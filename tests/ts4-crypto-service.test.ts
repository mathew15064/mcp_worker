import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import terminalCredentials = require('../src/services/terminalCredentialService');
import telegramSecrets = require('../src/services/telegramSecretService');
import terminalOrigins = require('../src/services/terminalPublicOriginService');
import terminalNonces = require('../src/services/terminalNonceService');

test('typed credential and Telegram envelopes preserve encryption formats and integrity', () => {
  const previous = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  try {
    const envelope = terminalCredentials.encrypt('safe-test-password');
    assert.ok(envelope.startsWith('v1:'));
    assert.equal(terminalCredentials.decrypt(envelope), 'safe-test-password');
    terminalCredentials.validateForCopy(envelope);
    const token = telegramSecrets.encrypt('test-bot-token');
    assert.ok(token.startsWith('enc:v3:'));
    assert.equal(telegramSecrets.decrypt(token), 'test-bot-token');
    assert.throws(() => terminalCredentials.decrypt(envelope.slice(0, -3) + 'AAA'), /credential/);
  } finally {
    if (previous === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previous;
  }
});

test('typed WebSocket nonce remains origin-bound and strictly one-time', () => {
  const origin = terminalOrigins.canonicalOrigin('https://stage.example.invalid');
  assert.equal(origin, 'https://stage.example.invalid');
  assert.equal(terminalOrigins.canonicalOrigin('https://user@stage.example.invalid'), null);
  const nonces = new terminalNonces.TerminalNonceService({ttlMs: 60000});
  try {
    const value = nonces.issue({
      sessionId: 'session-one', userId: 'test-user', sessionVersion: 1,
      profileId: 'profile-1', origin
    });
    const first = nonces.claim(value.attempt_id, value.nonce);
    assert.equal(first.code, null);
    assert.ok(first.record);
    assert.ok(nonces.matchesSession(first.record, 'session-one'));
    assert.equal(nonces.matchesSession(first.record, 'session-two'), false);
    assert.equal(nonces.claim(value.attempt_id, value.nonce).code, 'NONCE_REUSED');
  } finally { nonces.close(); }
});
