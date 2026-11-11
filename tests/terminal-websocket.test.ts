import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket, { type ClientOptions } from 'ws';
import nonceModule from '../src/services/terminalNonceService';
const { TerminalNonceService } = nonceModule;
import socketModule from '../src/services/terminalWebSocketService';
const { attachTerminalWebSocket, profileForIdentity } = socketModule;

function waitForEvent(target: WebSocket, event: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    target.once(event, resolve);
    target.once('error', reject);
  });
}

async function rejected(url: string, options: ClientOptions = {}): Promise<number> {
  return new Promise<number>((resolve) => {
    const ws = new WebSocket(url, options);
    ws.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode || 0);
      ws.terminate();
    });
    ws.on('error', () => resolve(0));
  });
}

void test('shell profile lookup preserves Admin/global and User ownership boundaries', async () => {
  const calls: string[][] = [];
  const repository = {
    async findAdminProfileById(id: string) {
      calls.push(['admin', id]);
      return { id, owner: null };
    },
    async findProfileByIdForOwner(id: string, ownerId: string) {
      calls.push(['user', id, ownerId]);
      return { id, owner: ownerId };
    },
  };
  assert.deepEqual(
    await profileForIdentity(
      repository as unknown as Parameters<typeof profileForIdentity>[0],
      { id: 'admin-1', role: 'admin' } as Parameters<typeof profileForIdentity>[1],
      'p-admin',
    ),
    { id: 'p-admin', owner: null },
  );
  assert.deepEqual(
    await profileForIdentity(
      repository as unknown as Parameters<typeof profileForIdentity>[0],
      { id: 'user-1', role: 'user' } as Parameters<typeof profileForIdentity>[1],
      'p-user',
    ),
    { id: 'p-user', owner: 'user-1' },
  );
  assert.equal(
    await profileForIdentity(
      repository as unknown as Parameters<typeof profileForIdentity>[0],
      { id: 'other', role: 'viewer' } as Parameters<typeof profileForIdentity>[1],
      'p-denied',
    ),
    null,
  );
  assert.deepEqual(calls, [
    ['admin', 'p-admin'],
    ['user', 'p-user', 'user-1'],
  ]);
});

void test('browser Worker shell WebSocket requires one-time nonce, owner session and same origin, then bridges PTY IO', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const wsBase = origin.replace('http:', 'ws:') + '/terminal/ws';
  const nonces = new TerminalNonceService();
  const inputs: string[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  let openCount = 0;
  let closeCount = 0;
  const streamRef: { current?: { onOutput(buffer: Buffer): void; onState(state: string): void } } =
    {};

  const gateway = attachTerminalWebSocket(server, {
    nonceService: nonces,
    sessionMiddleware(
      request: import('express').Request,
      _response: import('express').Response,
      next: import('express').NextFunction,
    ) {
      if (request.headers.cookie === 'sid=valid') {
        request.sessionID = 'session-1';
        request.session = {
          userId: 'admin-1',
          role: 'admin',
          sessionVersion: 1,
          reload(callback: (error?: unknown) => void) {
            callback();
            return this;
          },
        } as unknown as import('express').Request['session'];
      }
      next();
    },
    authService: {
      async currentIdentity(session: { userId?: string; role?: string } | undefined) {
        return session?.userId === 'admin-1' && session?.role === 'admin'
          ? { id: 'admin-1', role: 'admin', session_version: 1 }
          : null;
      },
    },
    workerRepository: {
      async findAdminProfileById(id: string) {
        return id === 'profile-1'
          ? { id, name: 'Fixture', enabled: true, worker_id: 'worker-1' }
          : null;
      },
      async findProfileByIdForOwner() {
        return null;
      },
    },
    workerBroker: {
      isOnline(workerId: string) {
        return workerId === 'worker-1';
      },
      async openStream(
        workerId: string,
        operation: string,
        payload: Record<string, unknown>,
        handlers: { onOutput(buffer: Buffer): void; onState(state: string): void },
      ) {
        assert.equal(workerId, 'worker-1');
        assert.equal(operation, 'shell.attach');
        assert.equal(payload.session_key, 'profile:profile-1');
        openCount += 1;
        streamRef.current = handlers;
        queueMicrotask(() => handlers.onState('CONNECTED'));
        return {
          input(data: string) {
            inputs.push(data);
          },
          resize(cols: number, rows: number) {
            resizes.push({ cols, rows });
          },
          close() {
            closeCount += 1;
          },
        } as unknown as import('express').Request['session'];
      },
    },
  } as unknown as Parameters<typeof attachTerminalWebSocket>[1]);

  t.after(async () => {
    gateway.close();
    nonces.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const issue = () =>
    nonces.issue({
      sessionId: 'session-1',
      userId: 'admin-1',
      sessionVersion: 1,
      profileId: 'profile-1',
      origin,
    });
  const url = (ticket: ReturnType<typeof nonces.issue>) =>
    `${wsBase}?attempt_id=${ticket.attempt_id}&nonce=${ticket.nonce}`;

  let ticket = issue();
  assert.equal(await rejected(url(ticket), { headers: { Origin: origin } }), 401);
  ticket = issue();
  assert.equal(
    await rejected(url(ticket), {
      headers: { Origin: 'http://evil.invalid', Cookie: 'sid=valid' },
    }),
    403,
  );

  ticket = issue();
  const socket = new WebSocket(url(ticket), { headers: { Origin: origin, Cookie: 'sid=valid' } });
  const messages: { type: string; state?: string; data?: string }[] = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await waitForEvent(socket, 'open');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(openCount, 1);
  assert.ok(messages.some((message) => message.type === 'state' && message.state === 'CONNECTED'));

  if (!streamRef.current) throw new Error('Worker stream handlers missing');
  streamRef.current.onOutput(Buffer.from('fixture-output'));
  // Invalid frames must never reach the Worker transport.
  socket.send('not-json');
  socket.send(JSON.stringify({ type: 'input', data: { unexpected: true } }));
  socket.send(JSON.stringify({ type: 'resize', cols: -1, rows: 40 }));
  socket.send(JSON.stringify({ type: 'input', data: 'fixture-input' }));
  socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(inputs, ['fixture-input']);
  assert.ok(resizes.some((value) => value.rows === 40 && value.cols === 120));
  assert.ok(
    messages.some((message) => message.type === 'output' && message.data === 'fixture-output'),
  );

  assert.equal(
    await rejected(url(ticket), { headers: { Origin: origin, Cookie: 'sid=valid' } }),
    401,
  );
  socket.close();
  await waitForEvent(socket, 'close');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closeCount, 1);
});
