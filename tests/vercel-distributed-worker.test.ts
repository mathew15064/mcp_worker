import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Redis } from '@upstash/redis';
import { WebSocket } from 'ws';
import brokerModule from '../src/services/workerConnectionBroker';
import { DistributedWorkerRelay } from '../src/services/distributedWorkerRelay';

const { WorkerConnectionBroker } = brokerModule;

class MemoryRedis {
  values = new Map<string, unknown>();
  lists = new Map<string, unknown[]>();
  get<T>(key: string): Promise<T | null> {
    const raw = this.values.get(key);
    if (raw == null) return Promise.resolve(null);
    if (typeof raw === 'string' && (raw.startsWith('{') || raw.startsWith('['))) {
      return Promise.resolve(JSON.parse(raw) as T);
    }
    return Promise.resolve(raw as T);
  }
  set(key: string, value: unknown) {
    this.values.set(key, value);
    return Promise.resolve('OK');
  }
  del(key: string) {
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }
  lpop<T>(key: string): Promise<T | null> {
    const list = this.lists.get(key);
    return Promise.resolve((list?.shift() as T | undefined) ?? null);
  }
  rpush(key: string, value: unknown) {
    const list = this.lists.get(key) || [];
    list.push(value);
    this.lists.set(key, list);
    return Promise.resolve(list.length);
  }
  llen(key: string) {
    return Promise.resolve(this.lists.get(key)?.length ?? 0);
  }
  expire() {
    return Promise.resolve(1);
  }
  publish() {
    return Promise.resolve(1);
  }
  eval(_script: string, keys: string[], args: string[]): Promise<number> {
    if (_script.includes('RPUSH')) {
      if (this.values.get(keys[1]) !== args[3]) return Promise.resolve(-2);
      const list = this.lists.get(keys[0]) || [];
      if (list.length >= Number(args[1])) return Promise.resolve(-1);
      list.push(args[0]);
      this.lists.set(keys[0], list);
      return Promise.resolve(list.length);
    }
    if (this.values.get(keys[0]) !== args[0]) return Promise.resolve(0);
    if (_script.includes('DEL')) return this.del(keys[0]);
    return Promise.resolve(this.values.has(keys[0]) ? 1 : 0);
  }
}

void test('distributed relay forwards a Worker MCP command across two independent function instances', async () => {
  const id = crypto.randomUUID();
  const worker = { id, name: 'IsolatedWorker', enabled: true, capabilities: ['workspace.exec'] };
  const store = new MemoryRedis() as unknown as Redis;
  const workerRepo = {
    findWorkerById(key: string) {
      return Promise.resolve(key === id ? worker : null);
    },
    updateWorkerPresence() {
      return Promise.resolve(null);
    },
    updateWorkerCapabilities() {
      return Promise.resolve(null);
    },
    touchWorker() {
      return Promise.resolve(null);
    },
  } as unknown as NonNullable<
    ConstructorParameters<typeof WorkerConnectionBroker>[0]
  >['repository'];
  const receiving = new WorkerConnectionBroker({ repository: workerRepo, defaultTimeoutMs: 2500 });
  const sending = new WorkerConnectionBroker({ repository: workerRepo, defaultTimeoutMs: 2500 });
  let receivedOperations = 0;
  const ws = {
    readyState: WebSocket.OPEN,
    worker: worker,
    workerId: id,
    bufferedAmount: 0,
    send(data: string) {
      const msg = JSON.parse(data) as { type: string; job_id: string; operation: string };
      assert.equal(msg.type, 'job');
      assert.equal(msg.operation, 'workspace.exec');
      receivedOperations += 1;
      setImmediate(() =>
        receiving.handleMessage(
          ws as never,
          JSON.stringify({
            type: 'result',
            job_id: msg.job_id,
            ok: true,
            result: { code: 0, stdout: 'from worker' },
          }),
        ),
      );
    },
  };
  receiving.connections.set(id, ws as never);
  const owner = new DistributedWorkerRelay({
    redis: store,
    privateSeed: 'T'.repeat(43),
    pollIntervalMs: 100,
    localDispatch: (workerId, operation, payload, opts) =>
      receiving.dispatchInternal(workerId, operation, payload, { ...opts, remoteAllowed: false }),
  });
  const remote = new DistributedWorkerRelay({
    redis: store,
    privateSeed: 'T'.repeat(43),
    pollIntervalMs: 100,
    localDispatch: () => Promise.reject(new Error('No local Worker on second Function')),
  });
  sending.distributed = remote;
  try {
    await owner.register(id);
    assert.equal(await sending.isOnlineDistributed(id), true);
    const result = await sending.dispatch<{ code: number; stdout: string }>(
      id,
      'workspace.exec',
      { command: 'echo test' },
      { timeoutMs: 2500 },
    );
    assert.deepEqual(result, { code: 0, stdout: 'from worker' });
    assert.equal(receivedOperations, 1);
    await assert.rejects(
      () => sending.dispatch(id, 'forbidden.operation', {}, { timeoutMs: 2500 }),
      (err: unknown) =>
        err instanceof Error && 'code' in err && err.code === 'WORKER_CAPABILITY_DENIED',
    );
  } finally {
    await owner.close();
    await remote.close();
    sending.distributed = null;
    receiving.close();
    sending.close();
  }
});

void test('owner lease renewal/release cannot override newer connections', async () => {
  const redis = new MemoryRedis() as unknown as Redis;
  const id = crypto.randomUUID();
  const seed = 'Z'.repeat(43);
  const options = {
    redis,
    privateSeed: seed,
    localDispatch: () => Promise.resolve(null),
    pollIntervalMs: 100,
  };
  const a = new DistributedWorkerRelay(options);
  const b = new DistributedWorkerRelay(options);
  const outsider = new DistributedWorkerRelay({ ...options, privateSeed: 'Y'.repeat(43) });
  try {
    await a.register(id);
    assert.equal(await outsider.isOnline(id), false);
    assert.equal(await a.isOnline(id), true);
    await b.register(id);
    await a.unregister(id);
    assert.equal(await b.isOnline(id), true);
    await b.unregister(id);
    assert.equal(await a.isOnline(id), false);
  } finally {
    await a.close();
    await b.close();
    await outsider.close();
  }
});

void test('owner namespaces isolate identical Worker IDs in a shared Redis', async () => {
  const memory = new MemoryRedis();
  const redis = memory as unknown as Redis;
  const workerId = crypto.randomUUID();
  const options = { redis, pollIntervalMs: 100 };
  const ownerA = new DistributedWorkerRelay({
    ...options,
    privateSeed: 'A'.repeat(43),
    localDispatch: () => Promise.resolve('owner-A'),
  });
  const ownerB = new DistributedWorkerRelay({
    ...options,
    privateSeed: 'B'.repeat(43),
    localDispatch: () => Promise.resolve('owner-B'),
  });
  const clientA = new DistributedWorkerRelay({
    ...options,
    privateSeed: 'A'.repeat(43),
    localDispatch: () => Promise.reject(new Error('not local')),
  });
  const clientB = new DistributedWorkerRelay({
    ...options,
    privateSeed: 'B'.repeat(43),
    localDispatch: () => Promise.reject(new Error('not local')),
  });
  try {
    assert.notEqual(ownerA.prefix, ownerB.prefix);
    await ownerA.register(workerId);
    await ownerB.register(workerId);
    const [answerA, answerB] = await Promise.all([
      clientA.dispatch(
        workerId,
        'workspace.exec',
        {},
        {
          timeoutMs: 2500,
          enforceCapability: true,
        },
      ),
      clientB.dispatch(
        workerId,
        'workspace.exec',
        {},
        {
          timeoutMs: 2500,
          enforceCapability: true,
        },
      ),
    ]);
    assert.equal(answerA, 'owner-A');
    assert.equal(answerB, 'owner-B');
    await ownerA.unregister(workerId);
    assert.equal(await clientA.isOnline(workerId), false);
    assert.equal(await clientB.isOnline(workerId), true);
    await assert.rejects(
      () =>
        clientA.dispatch(
          workerId,
          'workspace.exec',
          {},
          {
            timeoutMs: 100,
            enforceCapability: true,
          },
        ),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'WORKER_OFFLINE',
    );
  } finally {
    await Promise.allSettled([ownerA.close(), ownerB.close(), clientA.close(), clientB.close()]);
  }
});

void test('cross-Function queue admission stays bounded under concurrent dispatch', async () => {
  const memory = new MemoryRedis();
  const redis = memory as unknown as Redis;
  const relay = new DistributedWorkerRelay({
    redis,
    privateSeed: 'Q'.repeat(43),
    localDispatch: () => Promise.resolve(null),
  });
  const workerId = crypto.randomUUID();
  const target = '00000000-0000-4000-8000-000000000000';
  const key = relay.prefix + 'queue:' + target;
  try {
    await redis.set(relay.prefix + 'route:' + workerId, target);
    memory.lists.set(key, Array(127).fill('{}'));
    const result = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        relay.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 100, enforceCapability: true }),
      ),
    );
    assert.equal(memory.lists.get(key)?.length, 128);
    const hasCode = (entry: PromiseSettledResult<unknown>, code: string) => {
      if (entry.status !== 'rejected') return false;
      const reason: unknown = entry.reason;
      return (
        typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === code
      );
    };
    assert.equal(result.filter((entry) => hasCode(entry, 'WORKER_BUSY')).length, 9);
    assert.equal(result.filter((entry) => hasCode(entry, 'WORKER_JOB_TIMEOUT')).length, 1);
  } finally {
    await relay.close();
  }
});

void test('relay consumer refuses an injected capability-bypassing operation', async () => {
  const memory = new MemoryRedis();
  const redis = memory as unknown as Redis;
  const workerId = crypto.randomUUID();
  let calls = 0;
  const relay = new DistributedWorkerRelay({
    redis,
    privateSeed: 'R'.repeat(43),
    pollIntervalMs: 100,
    localDispatch: () => {
      calls += 1;
      return Promise.resolve('wrong');
    },
  });
  try {
    await relay.register(workerId);
    const id = 'r_' + crypto.randomUUID();
    await redis.rpush(
      relay.prefix + 'queue:' + relay.instanceId,
      JSON.stringify({
        id,
        workerId,
        operation: 'workspace.exec',
        payload: {},
        timeoutMs: 1000,
        enforceCapability: false,
      }),
    );
    const answerKey = relay.prefix + 'answer:' + id;
    let answer: { ok?: boolean; error?: { code?: string } } | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      answer = await redis.get(answerKey);
      if (answer) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(calls, 0);
    assert.equal(answer?.ok, false);
    assert.equal(answer?.error?.code, 'WORKER_CONTROL_OPERATION_DENIED');
  } finally {
    await relay.close();
  }
});

void test('queue admission refuses an owner lease replaced before Redis EVAL', async () => {
  const memory = new MemoryRedis();
  const redis = memory as unknown as Redis;
  const relay = new DistributedWorkerRelay({
    redis,
    privateSeed: 'S'.repeat(43),
    localDispatch: () => Promise.resolve(null),
  });
  const id = crypto.randomUUID();
  const route = relay.prefix + 'route:' + id;
  const firstOwner = crypto.randomUUID();
  const replacement = crypto.randomUUID();
  memory.values.set(route, firstOwner);
  const originalGet = memory.get.bind(memory);
  let exchanged = false;
  memory.get = <T>(key: string): Promise<T | null> => {
    const result = originalGet<T>(key);
    if (!exchanged && key === route) {
      exchanged = true;
      memory.values.set(route, replacement);
    }
    return result;
  };
  try {
    await assert.rejects(
      () => relay.dispatch(id, 'workspace.exec', {}, { timeoutMs: 200, enforceCapability: true }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'WORKER_REPLACED',
    );
    assert.equal(memory.lists.size, 0, 'No request may enter a superseded Function queue');
  } finally {
    await relay.close();
  }
});

void test('pending remote dispatch fails promptly if Worker owner disconnects', async () => {
  const memory = new MemoryRedis();
  const redis = memory as unknown as Redis;
  const relay = new DistributedWorkerRelay({
    redis,
    privateSeed: 'W'.repeat(43),
    localDispatch: () => Promise.resolve(null),
  });
  const id = crypto.randomUUID();
  const route = relay.prefix + 'route:' + id;
  memory.values.set(route, crypto.randomUUID());
  const started = Date.now();
  try {
    const task = relay.dispatch(
      id,
      'workspace.exec',
      {},
      {
        timeoutMs: 4000,
        enforceCapability: true,
      },
    );
    setTimeout(() => memory.values.delete(route), 100);
    await assert.rejects(
      task,
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'WORKER_REPLACED',
    );
    assert.ok(Date.now() - started < 2500, 'Waiter should not stall for the command timeout');
  } finally {
    await relay.close();
  }
});
