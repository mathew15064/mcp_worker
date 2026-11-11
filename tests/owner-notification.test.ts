import test from 'node:test';
import assert from 'node:assert/strict';
import notification from '../src/services/ownerNotificationService';
const { OwnerNotificationService } = notification;
interface Delivery {
  token: string;
  chatId: string;
  text: string;
}

void test('Owner notification distinguishes rejected and stopped Worker tasks', async () => {
  const values = new Map([
    ['telegram.enabled', 'true'],
    ['telegram.bot_token', 'encrypted-token'],
    ['telegram.chat_id', '123456'],
  ]);
  const sent: Delivery[] = [];
  const service = new OwnerNotificationService({
    settings: {
      async get(key: string, fallback: string | null = null) {
        return values.has(key) ? values.get(key) : fallback;
      },
    },
    secrets: {
      decrypt(value: string) {
        assert.equal(value, 'encrypted-token');
        return '123456:fixture-token';
      },
    },
    telegram: {
      async sendMessage(token: string, chatId: string, text: string) {
        sent.push({ token, chatId, text });
        return { message_id: sent.length };
      },
    },
    database: {
      isOperational() {
        return true;
      },
    },
  } as unknown as ConstructorParameters<typeof OwnerNotificationService>[0]);

  const rejected = await service.sendWorkerResourceAlert({
    code: 'WORKER_MEMORY_EMERGENCY',
    phase: 'task_start',
    workerName: 'VPS-01',
    memoryUsedPercent: 91.25,
    memoryTotalBytes: 4 * 1024 ** 3,
    memoryAvailableBytes: 350 * 1024 ** 2,
    thresholdPercent: 90,
    stopped: { workspace_commands: 0, managed_processes: 0 },
  });
  assert.deepEqual(rejected, { sent: true, message_id: 1 });
  assert.match(sent[0].text, /task rejected by RAM guard/);
  assert.match(sent[0].text, /not started/);
  assert.match(sent[0].text, /Idle host memory is otherwise left untouched/);
  assert.doesNotMatch(sent[0].text, /85%/);

  const stopped = await service.sendWorkerResourceAlert({
    code: 'WORKER_MEMORY_EMERGENCY',
    phase: 'task_running',
    workerName: 'VPS-01',
    memoryUsedPercent: 92.1,
    memoryTotalBytes: 4 * 1024 ** 3,
    memoryAvailableBytes: 300 * 1024 ** 2,
    thresholdPercent: 90,
    stopped: { workspace_commands: 1, managed_processes: 2 },
  });
  assert.deepEqual(stopped, { sent: true, message_id: 2 });
  assert.match(sent[1].text, /task stopped by RAM guard/);
  assert.match(sent[1].text, /workspace=1, process=2/);
  assert.match(sent[1].text, /task-scoped/);
  assert.doesNotMatch(sent[1].text, /below 85%/);

  const recoveredText = service.formatWorkerResourceAlert({
    code: 'WORKER_MEMORY_RECOVERED',
    workerName: 'legacy-worker',
    memoryUsedPercent: 44.5,
    memoryTotalBytes: 4 * 1024 ** 3,
    memoryAvailableBytes: 2 * 1024 ** 3,
  });
  assert.match(recoveredText, /memory recovered/);
  assert.match(recoveredText, /Legacy Worker recovery event received/);
});

void test('Owner notification does not send when Admin Telegram is disabled', async () => {
  const service = new OwnerNotificationService({
    settings: {
      async get(key: string, fallback: string | null = null) {
        return key === 'telegram.enabled' ? 'false' : fallback;
      },
    },
    secrets: {
      decrypt() {
        throw new Error('must not decrypt');
      },
    },
    telegram: {
      async sendMessage() {
        throw new Error('must not send');
      },
    },
    database: {
      isOperational() {
        return true;
      },
    },
  } as unknown as ConstructorParameters<typeof OwnerNotificationService>[0]);
  assert.deepEqual(await service.sendWorkerResourceAlert({ code: 'WORKER_MEMORY_EMERGENCY' }), {
    sent: false,
    reason: 'telegram_not_configured',
  });
});
