import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import workerBrokerModule from '../src/services/workerConnectionBroker';
const { WorkerConnectionBroker } = workerBrokerModule;

function upgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 2000 });
    let complete = false;
    ws.on('unexpected-response', (_request, response) => {
      complete = true;
      resolve(response.statusCode || 0);
      ws.terminate();
    });
    ws.on('open', () => {
      complete = true;
      resolve(101);
      ws.close();
    });
    ws.on('error', (error) => {
      if (!complete) reject(error);
    });
  });
}

void test('retired browser terminal WebSocket is denied while Worker auth remains enforced', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = new WorkerConnectionBroker({
    authService: {
      async authenticateConnect() {
        throw Object.assign(new Error('Worker identity required'), {
          code: 'WORKER_AUTH_INVALID',
          status: 401,
        });
      },
      normalizeCapabilities() {
        return [];
      },
    } as unknown as NonNullable<
      ConstructorParameters<typeof WorkerConnectionBroker>[0]
    >['authService'],
  });
  broker.attach(server);
  t.after(async () => {
    broker.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  const wsRoot = 'ws://127.0.0.1:' + address.port;
  assert.equal(await upgradeStatus(wsRoot + '/terminal/ws'), 404);
  assert.equal(await upgradeStatus(wsRoot + '/admin/terminal/ws'), 404);
  assert.equal(await upgradeStatus(wsRoot + '/worker/v1/connect'), 401);
});
