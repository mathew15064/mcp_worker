const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { WebSocket } = require('ws');
const { WorkerConnectionBroker } = require('../src/services/workerConnectionBroker');

test('broker exposes only the fixed worker lifecycle control operation', async () => {
  const workerId = crypto.randomUUID();
  const workerRecord = { id: workerId, capabilities: ['workspace.exec'], enabled: true };
  const broker = new WorkerConnectionBroker({
    repository: { findWorkerById: async id => id === workerId ? workerRecord : null },
    defaultTimeoutMs: 1000
  });
  let outbound = null;
  const ws = {
    workerId,
    worker: workerRecord,
    readyState: WebSocket.OPEN,
    send(text) { outbound = JSON.parse(text); }
  };
  broker.connections.set(workerId, ws);

  const pending = broker.dispatchControl(workerId, 'worker.self_uninstall', { confirm: 'REMOVE_THIS_WORKER' }, { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(outbound.type, 'job');
  assert.equal(outbound.operation, 'worker.self_uninstall');
  assert.deepEqual(outbound.payload, { confirm: 'REMOVE_THIS_WORKER' });
  broker.handleMessage(ws, JSON.stringify({ type: 'result', job_id: outbound.job_id, ok: true, result: { code: 'UNINSTALLED' } }));
  assert.deepEqual(await pending, { code: 'UNINSTALLED' });

  await assert.rejects(
    () => broker.dispatchControl(workerId, 'workspace.exec', {}, { timeoutMs: 100 }),
    error => error.code === 'WORKER_CONTROL_OPERATION_DENIED'
  );
  broker.close();
});
