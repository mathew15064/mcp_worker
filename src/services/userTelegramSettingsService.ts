import settingsRepo from '../repositories/settingsRepository';
import telegramSecrets from './telegramSecretService';

function assertUserId(userId: unknown) {
  const value = String(userId || '').trim();
  if (!/^usr_[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid user identity.');
  return value;
}

function keys(userId: string) {
  const id = assertUserId(userId);
  const prefix = `user.${id}.telegram`;
  return {
    enabled: `${prefix}.enabled`,
    chatId: `${prefix}.chat_id`,
    botToken: `${prefix}.bot_token`,
  };
}

function normalizeChatId(value: unknown) {
  const chatId = String(value || '').trim();
  if (chatId.length > 128 || /[\x00-\x1f\x7f]/.test(chatId))
    throw new Error('Telegram Chat ID is invalid.');
  return chatId;
}

type Settings = Pick<typeof settingsRepo, 'get' | 'set'>;
type Secrets = Pick<typeof telegramSecrets, 'encrypt' | 'decrypt'>;
interface ServiceOptions {
  settings?: Settings;
  secrets?: Secrets;
}
interface TelegramInput {
  enabled?: boolean;
  chatId?: string;
  botToken?: string;
}
class UserTelegramSettingsService {
  settings: Settings;
  secrets: Secrets;
  constructor({ settings = settingsRepo, secrets = telegramSecrets }: ServiceOptions = {}) {
    this.settings = settings;
    this.secrets = secrets;
  }

  async get(userId: string) {
    const k = keys(userId);
    const [enabled, chatId, token] = await Promise.all([
      this.settings.get(k.enabled, 'false'),
      this.settings.get(k.chatId, ''),
      this.settings.get(k.botToken, ''),
    ]);
    return {
      enabled: enabled === 'true' || enabled === '1',
      chatId: String(chatId || ''),
      hasToken: Boolean(String(token || '').trim()),
    };
  }

  async save(userId: string, { enabled = false, chatId = '', botToken = '' }: TelegramInput = {}) {
    const k = keys(userId);
    const normalizedChatId = normalizeChatId(chatId);
    const token = String(botToken || '').trim();
    await this.settings.set(k.enabled, enabled ? 'true' : 'false');
    await this.settings.set(k.chatId, normalizedChatId);
    if (token) await this.settings.set(k.botToken, this.secrets.encrypt(token));
    return this.get(userId);
  }

  async credentials(userId: string) {
    const k = keys(userId);
    const [encrypted, chatId] = await Promise.all([
      this.settings.get(k.botToken, ''),
      this.settings.get(k.chatId, ''),
    ]);
    if (!encrypted || !chatId)
      throw new Error('Telegram Bot Token and Chat ID must be configured first.');
    return { token: this.secrets.decrypt(encrypted), chatId: String(chatId) };
  }
}

export = Object.assign(new UserTelegramSettingsService(), {
  UserTelegramSettingsService,
  keys,
  normalizeChatId,
});
