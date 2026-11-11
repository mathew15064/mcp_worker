const test = require('node:test');
const assert = require('node:assert/strict');
const { UserTelegramSettingsService, keys } = require('../src/services/userTelegramSettingsService');

class MemorySettings {
  constructor() { this.values = new Map(); }
  async get(key, fallback = null) { return this.values.has(key) ? this.values.get(key) : fallback; }
  async set(key, value) { this.values.set(key, String(value ?? '')); }
}

const secrets = {
  encrypt(value) { return `encrypted:${value}`; },
  decrypt(value) { return String(value).replace(/^encrypted:/, ''); }
};

test('user Telegram settings are namespaced per user and never fall back to Admin Telegram keys', async () => {
  const settings = new MemorySettings();
  settings.values.set('telegram.enabled', 'true');
  settings.values.set('telegram.chat_id', 'admin-chat');
  settings.values.set('telegram.bot_token', 'encrypted:admin-token');
  const service = new UserTelegramSettingsService({ settings, secrets });
  const alice = 'usr_11111111-2222-4333-8444-555555555555';
  const bob = 'usr_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  assert.deepEqual(await service.get(alice), { enabled: false, chatId: '', hasToken: false });
  await service.save(alice, { enabled: true, chatId: 'alice-chat', botToken: 'alice-token' });
  assert.deepEqual(await service.get(alice), { enabled: true, chatId: 'alice-chat', hasToken: true });
  assert.deepEqual(await service.credentials(alice), { token: 'alice-token', chatId: 'alice-chat' });
  assert.deepEqual(await service.get(bob), { enabled: false, chatId: '', hasToken: false });

  const aliceKeys = keys(alice);
  assert.equal(settings.values.get(aliceKeys.botToken), 'encrypted:alice-token');
  assert.equal(settings.values.get('telegram.bot_token'), 'encrypted:admin-token');
});

test('saving a blank user Telegram token preserves the existing encrypted token', async () => {
  const settings = new MemorySettings();
  const service = new UserTelegramSettingsService({ settings, secrets });
  const userId = 'usr_11111111-2222-4333-8444-555555555555';
  await service.save(userId, { enabled: true, chatId: '100', botToken: 'first-token' });
  await service.save(userId, { enabled: false, chatId: '200', botToken: '' });
  assert.deepEqual(await service.get(userId), { enabled: false, chatId: '200', hasToken: true });
  assert.deepEqual(await service.credentials(userId), { token: 'first-token', chatId: '200' });
});
