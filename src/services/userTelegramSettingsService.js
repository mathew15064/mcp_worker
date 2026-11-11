const settingsRepo = require('../repositories/settingsRepository');
const telegramSecrets = require('./telegramSecretService');

function assertUserId(userId) {
  const value = String(userId || '').trim();
  if (!/^usr_[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid user identity.');
  return value;
}

function keys(userId) {
  const id = assertUserId(userId);
  const prefix = `user.${id}.telegram`;
  return {
    enabled: `${prefix}.enabled`,
    chatId: `${prefix}.chat_id`,
    botToken: `${prefix}.bot_token`
  };
}

function normalizeChatId(value) {
  const chatId = String(value || '').trim();
  if (chatId.length > 128 || /[\x00-\x1f\x7f]/.test(chatId)) throw new Error('Telegram Chat ID is invalid.');
  return chatId;
}

class UserTelegramSettingsService {
  constructor({ settings = settingsRepo, secrets = telegramSecrets } = {}) {
    this.settings = settings;
    this.secrets = secrets;
  }

  async get(userId) {
    const k = keys(userId);
    const [enabled, chatId, token] = await Promise.all([
      this.settings.get(k.enabled, 'false'),
      this.settings.get(k.chatId, ''),
      this.settings.get(k.botToken, '')
    ]);
    return {
      enabled: enabled === 'true' || enabled === '1',
      chatId: String(chatId || ''),
      hasToken: Boolean(String(token || '').trim())
    };
  }

  async save(userId, { enabled = false, chatId = '', botToken = '' } = {}) {
    const k = keys(userId);
    const normalizedChatId = normalizeChatId(chatId);
    const token = String(botToken || '').trim();
    await this.settings.set(k.enabled, enabled ? 'true' : 'false');
    await this.settings.set(k.chatId, normalizedChatId);
    if (token) await this.settings.set(k.botToken, this.secrets.encrypt(token));
    return this.get(userId);
  }

  async credentials(userId) {
    const k = keys(userId);
    const [encrypted, chatId] = await Promise.all([
      this.settings.get(k.botToken, ''),
      this.settings.get(k.chatId, '')
    ]);
    if (!encrypted || !chatId) throw new Error('Telegram Bot Token and Chat ID must be configured first.');
    return { token: this.secrets.decrypt(encrypted), chatId: String(chatId) };
  }
}

module.exports = new UserTelegramSettingsService();
module.exports.UserTelegramSettingsService = UserTelegramSettingsService;
module.exports.keys = keys;
module.exports.normalizeChatId = normalizeChatId;
