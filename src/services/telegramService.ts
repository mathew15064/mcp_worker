interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: { message_id?: number };
}
class TelegramService {
  fetchImpl: typeof fetch;
  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }
  async sendMessage(botToken: string, chatId: string, text: string) {
    const token = String(botToken || '').trim();
    const target = String(chatId || '').trim();
    const message = String(text || '').trim();
    if (!token || !target) throw new Error('Telegram Bot Token and Chat ID are required.');
    if (!message) throw new Error('Telegram message is required.');
    if (/[^0-9A-Za-z:_-]/.test(token) || token.length > 256)
      throw new Error('Telegram Bot Token format is invalid.');
    if (/[^0-9A-Za-z_@-]/.test(target) || target.length > 128)
      throw new Error('Telegram Chat ID format is invalid.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: target, text: message.slice(0, 4000) }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as TelegramResponse;
      if (!response.ok || payload.ok !== true)
        throw new Error(payload.description || `Telegram API returned HTTP ${response.status}.`);
      return { ok: true, message_id: payload.result?.message_id || null };
    } finally {
      clearTimeout(timer);
    }
  }
  async sendTest(botToken: string, chatId: string) {
    return this.sendMessage(
      botToken,
      chatId,
      `mcp_worker configuration test\n${new Date().toISOString()}`,
    );
  }
}
export = Object.assign(new TelegramService(), { TelegramService });
