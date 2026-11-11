class TelegramService {
  constructor(fetchImpl = globalThis.fetch) { this.fetchImpl = fetchImpl; }
  async sendMessage(botToken, chatId, text) {
    const token = String(botToken || '').trim();
    const target = String(chatId || '').trim();
    const message = String(text || '').trim();
    if (!token || !target) throw new Error('Telegram Bot Token and Chat ID are required.');
    if (!message) throw new Error('Telegram message is required.');
    if (/[^0-9A-Za-z:_-]/.test(token) || token.length > 256) throw new Error('Telegram Bot Token format is invalid.');
    if (/[^0-9A-Za-z_@-]/.test(target) || target.length > 128) throw new Error('Telegram Chat ID format is invalid.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: target, text: message.slice(0, 4000) }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.description || `Telegram API returned HTTP ${response.status}.`);
      return { ok: true, message_id: payload.result?.message_id || null };
    } finally { clearTimeout(timer); }
  }
  async sendTest(botToken, chatId) {
    return this.sendMessage(botToken, chatId, `Bot Report MCP configuration test\n${new Date().toISOString()}`);
  }
}
module.exports = new TelegramService();
module.exports.TelegramService = TelegramService;
