import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {WebSocket} from 'ws';
import workerBrokerModule = require('../src/services/workerConnectionBroker');
const {WorkerConnectionBroker} = workerBrokerModule;

test('broker exposes only the fixed worker lifecycle control operation', async () => {
  const workerId = crypto.randomUUID();
  const workerRecord = { id: workerId, capabilities: ['workspace.exec'], enabled: true };
  const broker = new WorkerConnectionBroker({
    repository: { findWorkerById: async (id: string) => id === workerId ? workerRecord : null } as unknown as ConstructorParameters<typeof WorkerConnectionBroker>[0] extends infer O ? O extends {repository?: infer R} ? R : never : never,
    defaultTimeoutMs: 1000
  });
  const messages: {outbound: {type: string;operation: string;payload: {confirm:string};job_id:string} | null} = {outbound: null};
  const ws = {
    workerId,
    worker: workerRecord,
    readyState: WebSocket.OPEN,
    send(text: string) { messages.outbound = JSON.parse(text); }
  };
  broker.connections.set(workerId, ws as unknown as Parameters<typeof broker.handleDisconnect>[0]);

  const pending = broker.dispatchControl(workerId, 'worker.self_uninstall', { confirm: 'REMOVE_THIS_WORKER' }, { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  const outbound = messages.outbound;
  if (!outbound) throw new Error('Worker control job was not sent');
  assert.equal(outbound.type, 'job');
  assert.equal(outbound.operation, 'worker.self_uninstall');
  assert.deepEqual(outbound.payload, { confirm: 'REMOVE_THIS_WORKER' });
  broker.handleMessage(ws as unknown as Parameters<typeof broker.handleDisconnect>[0], JSON.stringify({ type: 'result', job_id: outbound.job_id, ok: true, result: { code: 'UNINSTALLED' } }));
  assert.deepEqual(await pending, { code: 'UNINSTALLED' });

  await assert.rejects(
    () => broker.dispatchControl(workerId, 'workspace.exec', {}, { timeoutMs: 100 }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'WORKER_CONTROL_OPERATION_DENIED'
  );
  broker.close();
});
