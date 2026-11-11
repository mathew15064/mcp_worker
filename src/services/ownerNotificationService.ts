import databaseManager from '../db/databaseManager';
import settingsRepo from '../repositories/settingsRepository';
import telegramSecrets from './telegramSecretService';
import telegramService from './telegramService';

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function mb(bytes: unknown) {
  return Math.max(0, Math.round(number(bytes) / (1024 * 1024)));
}

interface ResourceAlert {
  code: string;
  phase?: string;
  workerName?: string;
  workerId?: string;
  memoryUsedPercent?: number;
  memoryAvailableBytes?: number;
  memoryTotalBytes?: number;
  thresholdPercent?: number;
  stopped?: { workspace_commands?: number; managed_processes?: number };
}
interface NotificationOptions {
  settings?: Pick<typeof settingsRepo, 'get'>;
  secrets?: Pick<typeof telegramSecrets, 'decrypt'>;
  telegram?: Pick<typeof telegramService, 'sendMessage'>;
  database?: Pick<typeof databaseManager, 'isOperational'>;
}
class OwnerNotificationService {
  settings: NonNullable<NotificationOptions['settings']>;
  secrets: NonNullable<NotificationOptions['secrets']>;
  telegram: NonNullable<NotificationOptions['telegram']>;
  database: NonNullable<NotificationOptions['database']>;

  constructor({
    settings = settingsRepo,
    secrets = telegramSecrets,
    telegram = telegramService,
    database = databaseManager,
  }: NotificationOptions = {}) {
    this.settings = settings;
    this.secrets = secrets;
    this.telegram = telegram;
    this.database = database;
  }

  async adminTelegramCredentials() {
    if (!this.database.isOperational()) return null;
    const enabled =
      (await this.settings.get('telegram.enabled', null)) ??
      (await this.settings.get('telegram_mcp_enabled', null)) ??
      (await this.settings.get('telegram_enabled', 'false'));
    if (enabled !== 'true') return null;
    const encrypted =
      (await this.settings.get('telegram.bot_token', null)) ??
      (await this.settings.get('telegram_mcp_bot_token', null)) ??
      (await this.settings.get('telegram_bot_token', ''));
    const chatId =
      (await this.settings.get('telegram.chat_id', null)) ??
      (await this.settings.get('telegram_mcp_chat_id', null)) ??
      (await this.settings.get('telegram_chat_id', ''));
    if (!encrypted || !chatId) return null;
    return { token: this.secrets.decrypt(encrypted), chatId: String(chatId) };
  }

  formatWorkerResourceAlert(alert: ResourceAlert) {
    const name = String(alert.workerName || alert.workerId || 'unknown').slice(0, 120);
    const used = number(alert.memoryUsedPercent).toFixed(1);
    const available = mb(alert.memoryAvailableBytes);
    const total = mb(alert.memoryTotalBytes);
    const limit = number(alert.thresholdPercent, 90).toFixed(0);
    if (alert.code === 'WORKER_MEMORY_RECOVERED') {
      return `✅ mcp_worker Worker memory recovered\nWorker: ${name}\nRAM used: ${used}%\nAvailable: ${available} MiB / ${total} MiB\nLegacy Worker recovery event received.`;
    }
    if (alert.phase === 'task_start') {
      return `🚨 mcp_worker Worker task rejected by RAM guard\nWorker: ${name}\nRAM used: ${used}% (hard limit ${limit}%)\nAvailable: ${available} MiB / ${total} MiB\nThe requested Worker task was not started. Idle host memory is otherwise left untouched.`;
    }
    const stopped = alert.stopped || {};
    return `🚨 mcp_worker Worker task stopped by RAM guard\nWorker: ${name}\nRAM used: ${used}% (hard limit ${limit}%)\nAvailable: ${available} MiB / ${total} MiB\nStopped active Worker workloads: workspace=${number(stopped.workspace_commands)}, process=${number(stopped.managed_processes)}\nThe guard is task-scoped; idle host memory is not managed.`;
  }

  async sendWorkerResourceAlert(alert: ResourceAlert) {
    const credentials = await this.adminTelegramCredentials();
    if (!credentials) return { sent: false, reason: 'telegram_not_configured' };
    const result = await this.telegram.sendMessage(
      credentials.token,
      credentials.chatId,
      this.formatWorkerResourceAlert(alert),
    );
    return { sent: true, message_id: result.message_id || null };
  }
}

export = Object.assign(new OwnerNotificationService(), { OwnerNotificationService });
