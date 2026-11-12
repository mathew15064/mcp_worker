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
