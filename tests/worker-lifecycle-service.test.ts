import test from 'node:test';
import assert from 'node:assert/strict';
import lifecycle from '../src/services/workerLifecycleService';
const { WorkerLifecycleService } = lifecycle;
type MockCall = {
  type: string;
  id?: string;
  options?: { ownerUserId?: string; reason?: string; timeoutMs?: number };
  operation?: string;
  payload?: { confirm?: string };
  entry?: { eventType?: string };
};

void test('worker decommission finalizes server state only after worker acknowledgement', async () => {
  const calls: MockCall[] = [];
  const repository = {
    deleteWorker(id: string, options?: { ownerUserId?: string }) {
      try {
        return Promise.resolve(
          (() => {
            calls.push({ type: 'delete', id, options });
            return true;
          })(),
        );
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('Mock action rejected'));
      }
    },
  };
  const broker = {
    isOnline: () => true,
    dispatchControl(
      id: string,
      operation: string,
      payload: { confirm?: string },
      options: { timeoutMs?: number },
    ) {
      try {
        return Promise.resolve(
          (() => {
            calls.push({ type: 'dispatch', id, operation, payload, options });
            return { code: 'UNINSTALLED' };
          })(),
        );
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('Mock action rejected'));
      }
    },
    disconnect(id: string, options?: { reason?: string }) {
      calls.push({ type: 'disconnect', id, options });
      return true;
    },
  };
  const audit = {
    log(entry: { eventType: string }) {
      try {
        return Promise.resolve(
          (() => {
            calls.push({ type: 'audit', entry });
          })(),
        );
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('Mock action rejected'));
      }
    },
  };
  const service = new WorkerLifecycleService({
    repository,
    broker,
    audit,
  } as unknown as ConstructorParameters<typeof WorkerLifecycleService>[0]);
  const worker = { id: 'worker-1', name: 'Worker One' };

  const result = await service.decommission(worker, {
    actorId: 'user:test',
    ownerUserId: 'user-1',
  });
  assert.equal(result.code, 'UNINSTALLED');
  assert.equal(calls.find((call) => call.type === 'dispatch')?.operation, 'worker.self_uninstall');
  assert.equal(
    calls.find((call) => call.type === 'dispatch')?.payload?.confirm,
    'REMOVE_THIS_WORKER',
  );
  assert.equal(
    calls.findIndex((call) => call.type === 'dispatch') <
      calls.findIndex((call) => call.type === 'delete'),
    true,
  );
  assert.deepEqual(calls.find((call) => call.type === 'delete')?.options, {
    ownerUserId: 'user-1',
  });
  assert.ok(
    calls.some(
      (call) => call.type === 'audit' && call.entry?.eventType === 'WORKER_REMOTE_REMOVE_COMPLETED',
    ),
  );
});

void test('force remove deletes server state without remote uninstall acknowledgement', async () => {
  const calls: MockCall[] = [];
  const repository = {
    deleteWorker(id: string, options?: { ownerUserId?: string }) {
      try {
        return Promise.resolve(
          (() => {
            calls.push({ type: 'delete', id, options });
            return true;
          })(),
        );
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('Mock action rejected'));
      }
    },
  };
  const broker = {
    disconnect(id: string, options?: { reason?: string }) {
      calls.push({ type: 'disconnect', id, options });
      return true;
    },
  };
  const audit = {
    log(entry: { eventType: string }) {
      try {
        return Promise.resolve(
          (() => {
            calls.push({ type: 'audit', entry });
          })(),
        );
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('Mock action rejected'));
      }
    },
  };
  const service = new WorkerLifecycleService({
    repository,
    broker,
    audit,
  } as unknown as ConstructorParameters<typeof WorkerLifecycleService>[0]);
  const result = await service.forceRemove(
    { id: 'worker-force', name: 'Force Worker', status: 'offline' },
    { actorId: 'admin:test' },
  );
  assert.equal(result.code, 'FORCE_REMOVED');
  assert.ok(calls.some((call) => call.type === 'delete' && call.id === 'worker-force'));
  assert.ok(
    calls.some((call) => call.type === 'disconnect' && call.options?.reason === 'worker-removed'),
  );
  assert.ok(
    calls.some(
      (call) => call.type === 'audit' && call.entry?.eventType === 'WORKER_FORCE_REMOVE_COMPLETED',
    ),
  );
});

void test('worker decommission preserves server state when worker is offline or does not acknowledge', async () => {
  let deleted = false;
  const repository = {
    deleteWorker() {
      try {
        return Promise.resolve(
          (() => {
            deleted = true;
            return true;
          })(),
        );
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('Mock action rejected'));
      }
    },
  };
  const audit = { async log() {} };

  const offline = new WorkerLifecycleService({
    repository,
    broker: { isOnline: () => false },
    audit,
  } as unknown as ConstructorParameters<typeof WorkerLifecycleService>[0]);
  await assert.rejects(
    () => offline.decommission({ id: 'worker-2', name: 'Offline' }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_OFFLINE',
  );
  assert.equal(deleted, false);

  const noAck = new WorkerLifecycleService({
    repository,
    broker: {
      isOnline: () => true,
      dispatchControl() {
        try {
          return Promise.resolve(
            (() => {
              return { code: 'NOT_COMPLETE' };
            })(),
          );
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error('Mock action rejected'));
        }
      },
      disconnect() {},
    },
    audit,
  } as unknown as ConstructorParameters<typeof WorkerLifecycleService>[0]);
  await assert.rejects(
    () => noAck.decommission({ id: 'worker-3', name: 'No Ack' }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_UNINSTALL_INVALID_ACK',
  );
  assert.equal(deleted, false);
});
