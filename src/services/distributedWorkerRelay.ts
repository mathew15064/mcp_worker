import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';
import { managedRedis, managedRedisConnection } from '../config/managedStorage';
import type { WorkerPayload } from './workerProtocol';

/**
 * Per-project cross-Function relay for outbound Workers.
 *
 * The live WebSocket stays in one Vercel Function, while MCP HTTP calls may
 * land in another. Redis stores a short owner lease and a bounded queue of
 * job requests. No Go Worker protocol changes are necessary.
 *
 * Redis must belong to THIS user's Vercel project. Never use a shared
 * project-wide token or remotely supplied Redis endpoint.
 */
type Store = Pick<
  Redis,
  'get' | 'set' | 'del' | 'lpop' | 'rpush' | 'expire' | 'llen' | 'eval' | 'publish'
>;
type LocalDispatch = (
  workerId: string,
  operation: string,
  payload: WorkerPayload,
  options: { timeoutMs: number; enforceCapability: boolean },
) => Promise<unknown>;

interface RequestEnvelope {
  id: string;
  workerId: string;
  operation: string;
  payload: WorkerPayload;
  timeoutMs: number;
  enforceCapability: boolean;
}

interface ResponseEnvelope {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; status: number };
}

interface Options {
  redis?: Store;
  privateSeed?: string;
  localDispatch: LocalDispatch;
  onLeaseLost?: (workerId: string) => void;
  pollIntervalMs?: number;
  leaseSeconds?: number;
}

const LEASE_TOUCH =
  'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("EXPIRE",KEYS[1],ARGV[2]) else return 0 end';
const LEASE_DELETE =
  'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end';
// Bound admission and expiry are one Redis operation. A separate LLEN followed
// by RPUSH lets concurrent Vercel Functions all pass the same capacity check.
const QUEUE_PUSH =
  'if redis.call("LLEN",KEYS[1]) >= tonumber(ARGV[2]) then return -1 end ' +
  'local size = redis.call("RPUSH",KEYS[1],ARGV[1]); ' +
  'redis.call("EXPIRE",KEYS[1],tonumber(ARGV[3])); return size';

const fail = (code: string, message: string, status = 503): Error =>
  Object.assign(new Error(message), { code, status });

function isSafeId(value: string) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function resultValue(value: unknown): ResponseEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (typeof fields.ok !== 'boolean') return null;
  const error = fields.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const item = error as Record<string, unknown>;
    return {
      ok: false,
      error: {
        code:
          typeof item.code === 'string' && /^[A-Z0-9_]{3,64}$/.test(item.code)
            ? item.code
            : 'WORKER_EXECUTION_FAILED',
        message: typeof item.message === 'string' ? item.message.slice(0, 600) : 'Worker failed.',
        status:
          typeof item.status === 'number' && item.status >= 400 && item.status <= 599
            ? item.status
            : 503,
      },
    };
  }
  return { ok: fields.ok, value: fields.value };
}

export class DistributedWorkerRelay {
  readonly instanceId = crypto.randomUUID();
  readonly prefix: string;
  readonly redis: Store;
  readonly localDispatch: LocalDispatch;
  readonly onLeaseLost?: (workerId: string) => void;
  readonly pollIntervalMs: number;
  readonly leaseSeconds: number;
  private readonly connected = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private renewing = false;
  private readonly useRealtimeNotification: boolean;
  private subscriptionController: AbortController | null = null;
  private subscriptionTask: Promise<void> | null = null;

  constructor({
    redis = managedRedis(),
    privateSeed = process.env.MCP_SETUP_SECRET || '',
    localDispatch,
    onLeaseLost,
    pollIntervalMs = 1500,
    leaseSeconds = 45,
  }: Options) {
    if (!privateSeed || privateSeed.length < 43)
      throw new Error('Distributed Worker relay requires a private instance key.');
    this.prefix =
      'mw:relay:' +
      crypto.createHash('sha256').update(privateSeed).digest('hex').slice(0, 20) +
      ':';
    this.redis = redis;
    this.localDispatch = localDispatch;
    this.onLeaseLost = onLeaseLost;
    this.pollIntervalMs = Math.max(100, Math.min(pollIntervalMs, 10000));
    this.leaseSeconds = Math.max(20, Math.min(leaseSeconds, 120));
    this.useRealtimeNotification =
      process.env.MCP_PLATFORM === 'vercel' &&
      redis instanceof Redis &&
      Boolean(managedRedisConnection());
  }

  private route(workerId: string) {
    return this.prefix + 'route:' + workerId;
  }
  private queue() {
    return this.prefix + 'queue:' + this.instanceId;
  }
  private channel(instanceId: string = this.instanceId) {
    return this.prefix + 'notify:' + instanceId;
  }
  private answer(id: string) {
    return this.prefix + 'answer:' + id;
  }

  async register(workerId: string) {
    if (!isSafeId(workerId)) throw fail('WORKER_ID_INVALID', 'Invalid worker identifier.', 400);
    await this.redis.set(this.route(workerId), this.instanceId, { ex: this.leaseSeconds });
    this.connected.add(workerId);
    this.start();
  }

  async unregister(workerId: string) {
    this.connected.delete(workerId);
    await this.redis.eval(LEASE_DELETE, [this.route(workerId)], [this.instanceId]);
    if (!this.connected.size) this.stopTimers();
  }

  async isOnline(workerId: string): Promise<boolean> {
    if (!isSafeId(workerId)) return false;
    return Boolean(await this.redis.get<string>(this.route(workerId)));
  }

  private start() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(
      () => {
        void this.poll().catch(() => {});
      },
      this.useRealtimeNotification ? 30000 : this.pollIntervalMs,
    );
    if (this.useRealtimeNotification) this.startSubscription();
    this.leaseTimer = setInterval(() => {
      void this.renew().catch(() => {});
    }, this.leaseSeconds * 400);
    this.pollTimer.unref();
    this.leaseTimer.unref();
    void this.poll().catch(() => {});
  }

  private stopTimers() {
    this.subscriptionController?.abort();
    this.subscriptionController = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.pollTimer = null;
    this.leaseTimer = null;
  }

  /** Upstash REST provides SSE SUBSCRIBE. A 30-second fallback poll keeps
   * persisted jobs safe during brief notification disconnects.
   */
  private startSubscription() {
    if (this.subscriptionTask || !this.connected.size) return;
    const task = this.subscriptionLoop();
    this.subscriptionTask = task;
    void task
      .finally(() => {
        if (this.subscriptionTask === task) {
          this.subscriptionTask = null;
          if (this.connected.size) setImmediate(() => this.startSubscription());
        }
      })
      .catch(() => {});
  }

  private async subscriptionLoop() {
    const creds = managedRedisConnection();
    const base = creds?.url || '';
    const token = creds?.token || '';
    if (!base || !token) return;
    while (this.connected.size) {
      const controller = new AbortController();
      this.subscriptionController = controller;
      try {
        const endpoint =
          base.replace(/\/+$/, '') + '/subscribe/' + encodeURIComponent(this.channel());
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error('Upstash SUBSCRIBE unavailable.');
        await this.poll();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (this.connected.size && !controller.signal.aborted) {
          const message = await reader.read();
          if (message.done) break;
          buffer += decoder.decode(message.value, { stream: true });
          if (buffer.length > 16384) buffer = buffer.slice(-4096);
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          if (lines.some((line) => line.startsWith('data:'))) await this.poll();
        }
      } catch {
        // No secret or upstream response body is logged.
      } finally {
        if (this.subscriptionController === controller) this.subscriptionController = null;
        controller.abort();
      }
      if (!this.connected.size) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    }
  }

  private async renew() {
    if (this.renewing || !this.connected.size) return;
    this.renewing = true;
    try {
      for (const workerId of [...this.connected]) {
        const renewed = await this.redis.eval(
          LEASE_TOUCH,
          [this.route(workerId)],
          [this.instanceId, String(this.leaseSeconds)],
        );
        if (Number(renewed) !== 1) {
          this.connected.delete(workerId);
          this.onLeaseLost?.(workerId);
        }
      }
      if (!this.connected.size) this.stopTimers();
    } finally {
      this.renewing = false;
    }
  }

  private async poll() {
    if (this.polling || !this.connected.size) return;
    this.polling = true;
    try {
      for (let count = 0; count < 16; count += 1) {
        if (this.inFlight.size >= 64) break;
        const raw: unknown = await this.redis.lpop<unknown>(this.queue());
        if (raw == null) break;
        const request = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
        const task = this.accept(request);
        this.inFlight.add(task);
        void task.finally(() => this.inFlight.delete(task)).catch(() => {});
      }
    } finally {
      this.polling = false;
    }
  }

  private async accept(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const req = raw as Partial<RequestEnvelope>;
    if (
      !req.id ||
      !isSafeId(req.id) ||
      !req.workerId ||
      !isSafeId(req.workerId) ||
      typeof req.operation !== 'string' ||
      !req.operation ||
      !req.payload ||
      typeof req.payload !== 'object' ||
      Array.isArray(req.payload) ||
      typeof req.timeoutMs !== 'number' ||
      !Number.isFinite(req.timeoutMs) ||
      req.timeoutMs < 100 ||
      req.timeoutMs > 240_000 ||
      typeof req.enforceCapability !== 'boolean'
    )
      return;
    const replyKey = this.answer(req.id);
    try {
      if (
        !this.connected.has(req.workerId) ||
        (await this.redis.get<string>(this.route(req.workerId))) !== this.instanceId
      )
        throw fail('WORKER_DISCONNECTED', 'Worker connection is no longer current.');
      // Control operations bypass capabilities only for the one approved action.
      // Do not trust an enqueued flag without revalidating it at the consumer.
      if (!req.enforceCapability && req.operation !== 'worker.self_uninstall')
        throw fail(
          'WORKER_CONTROL_OPERATION_DENIED',
          'Unsupported worker control operation.',
          403,
        );
      const value = await this.localDispatch(req.workerId, req.operation, req.payload, {
        timeoutMs: req.timeoutMs,
        enforceCapability: req.enforceCapability,
      });
      const text = JSON.stringify({ ok: true, value });
      if (text.length > 1_048_576)
        throw fail('WORKER_REPLY_TOO_LARGE', 'Worker response exceeds relay limit.', 413);
      await this.redis.set(replyKey, text, { ex: 120 });
    } catch (error) {
      const fields =
        error && typeof error === 'object'
          ? (error as { code?: string; message?: string; status?: number })
          : {};
      await this.redis.set(
        replyKey,
        JSON.stringify({
          ok: false,
          error: {
            code: fields.code || 'WORKER_EXECUTION_FAILED',
            message: String(fields.message || 'Worker command failed.').slice(0, 600),
            status: Number(fields.status || 503),
          },
        }),
        { ex: 120 },
      );
    }
  }

  async dispatch<T = unknown>(
    workerId: string,
    operation: string,
    payload: WorkerPayload,
    { timeoutMs, enforceCapability }: { timeoutMs: number; enforceCapability: boolean },
  ): Promise<T> {
    if (!isSafeId(workerId)) throw fail('WORKER_ID_INVALID', 'Invalid Worker identifier.', 400);
    const owner = await this.redis.get<string>(this.route(workerId));
    if (!owner || !/^[a-f0-9-]{36}$/.test(owner))
      throw fail('WORKER_OFFLINE', 'Worker is not currently connected.');
    if (owner === this.instanceId && !this.connected.has(workerId))
      throw fail('WORKER_DISCONNECTED', 'Worker disconnected during dispatch.');
    const id = 'r_' + crypto.randomUUID();
    const timeout = Math.max(100, Math.min(timeoutMs, 240_000));
    const record: RequestEnvelope = {
      id,
      workerId,
      operation,
      payload,
      timeoutMs: timeout,
      enforceCapability,
    };
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json, 'utf8') > 768 * 1024)
      throw fail('WORKER_REQUEST_TOO_LARGE', 'Worker request exceeds relay limit.', 413);
    const queueKey = this.prefix + 'queue:' + owner;
    const size = Number(
      await this.redis.eval(QUEUE_PUSH, [queueKey], [
        json,
        '128',
        String(Math.ceil(timeout / 1000) + 30),
      ]),
    );
    if (size === -1) throw fail('WORKER_BUSY', 'Worker queue is busy.', 429);
    if (!Number.isInteger(size) || size < 1)
      throw fail('WORKER_RELAY_STORE_UNAVAILABLE', 'Worker queue admission failed.');
    // Notification is an optimization; the queue stays authoritative.
    await this.redis.publish(this.channel(owner), 'new-job').catch(() => {});

    const answerKey = this.answer(id);
    const deadline = Date.now() + timeout + 2000;
    try {
      while (Date.now() < deadline) {
        const raw: unknown = await this.redis.get<unknown>(answerKey);
        if (raw != null) {
          const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
          const result = resultValue(value);
          if (!result) throw fail('WORKER_RELAY_INVALID_REPLY', 'Invalid Worker relay reply.');
          if (!result.ok) {
            throw fail(
              result.error?.code || 'WORKER_EXECUTION_FAILED',
              result.error?.message || 'Worker request failed.',
              result.error?.status || 503,
            );
          }
          return result.value as T;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
      }
      throw fail('WORKER_JOB_TIMEOUT', 'Worker relay job timed out.', 504);
    } finally {
      await this.redis.del(answerKey).catch(() => {});
    }
  }

  async close() {
    this.stopTimers();
    const workers = [...this.connected];
    this.connected.clear();
    await Promise.allSettled(
      workers.map((workerId) =>
        this.redis.eval(LEASE_DELETE, [this.route(workerId)], [this.instanceId]),
      ),
    );
  }
}
