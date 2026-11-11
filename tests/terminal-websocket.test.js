const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { TerminalNonceService } = require('../src/services/terminalNonceService');
const { attachTerminalWebSocket, profileForIdentity } = require('../src/services/terminalWebSocketService');

function waitForEvent(target, event) {
  return new Promise((resolve, reject) => {
    target.once(event, resolve);
    target.once('error', reject);
  });
}

async function rejected(url, options = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, options);
    ws.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode);
      ws.terminate();
    });
    ws.on('error', () => resolve(0));
  });
}

test('shell profile lookup preserves Admin/global and User ownership boundaries', async () => {
  const calls = [];
  const repository = {
    async findAdminProfileById(id) { calls.push(['admin', id]); return { id, owner: null }; },
    async findProfileByIdForOwner(id, ownerId) { calls.push(['user', id, ownerId]); return { id, owner: ownerId }; }
  };
  assert.deepEqual(await profileForIdentity(repository, { id: 'admin-1', role: 'admin' }, 'p-admin'), { id: 'p-admin', owner: null });
  assert.deepEqual(await profileForIdentity(repository, { id: 'user-1', role: 'user' }, 'p-user'), { id: 'p-user', owner: 'user-1' });
  assert.equal(await profileForIdentity(repository, { id: 'other', role: 'viewer' }, 'p-denied'), null);
  assert.deepEqual(calls, [['admin', 'p-admin'], ['user', 'p-user', 'user-1']]);
});

test('browser Worker shell WebSocket requires one-time nonce, owner session and same origin, then bridges PTY IO', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const wsBase = origin.replace('http:', 'ws:') + '/terminal/ws';
  const nonces = new TerminalNonceService();
  const inputs = [];
  const resizes = [];
  let openCount = 0;
  let closeCount = 0;
  let streamHandlers = null;

  const gateway = attachTerminalWebSocket(server, {
    nonceService: nonces,
    sessionMiddleware(request, _response, next) {
      if (request.headers.cookie === 'sid=valid') {
        request.sessionID = 'session-1';
        request.session = {
          userId: 'admin-1', role: 'admin', sessionVersion: 1,
          reload(callback) { callback(); }
        };
      }
      next();
    },
    authService: {
      async currentIdentity(session) {
        return session?.userId === 'admin-1' && session?.role === 'admin'
          ? { id: 'admin-1', role: 'admin', session_version: 1 }
          : null;
      }
    },
    workerRepository: {
      async findAdminProfileById(id) {
        return id === 'profile-1' ? { id, name: 'Fixture', enabled: true, worker_id: 'worker-1' } : null;
      },
      async findProfileByIdForOwner() { return null; }
    },
    workerBroker: {
      isOnline(workerId) { return workerId === 'worker-1'; },
      async openStream(workerId, operation, payload, handlers) {
        assert.equal(workerId, 'worker-1');
        assert.equal(operation, 'shell.attach');
        assert.equal(payload.session_key, 'profile:profile-1');
        openCount += 1;
        streamHandlers = handlers;
        queueMicrotask(() => handlers.onState('CONNECTED'));
        return {
          input(data) { inputs.push(data); },
          resize(cols, rows) { resizes.push({ cols, rows }); },
          close() { closeCount += 1; }
        };
      }
    }
  });

  t.after(async () => {
    gateway.close();
    nonces.close();
    await new Promise(resolve => server.close(resolve));
  });

  const issue = () => nonces.issue({
    sessionId: 'session-1',
    userId: 'admin-1',
    sessionVersion: 1,
    profileId: 'profile-1',
    origin
  });
  const url = ticket => `${wsBase}?attempt_id=${ticket.attempt_id}&nonce=${ticket.nonce}`;

  let ticket = issue();
  assert.equal(await rejected(url(ticket), { headers: { Origin: origin } }), 401);
  ticket = issue();
  assert.equal(await rejected(url(ticket), { headers: { Origin: 'http://evil.invalid', Cookie: 'sid=valid' } }), 403);

  ticket = issue();
  const socket = new WebSocket(url(ticket), { headers: { Origin: origin, Cookie: 'sid=valid' } });
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await waitForEvent(socket, 'open');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(openCount, 1);
  assert.ok(messages.some(message => message.type === 'state' && message.state === 'CONNECTED'));

  streamHandlers.onOutput(Buffer.from('fixture-output'));
  socket.send(JSON.stringify({ type: 'input', data: 'fixture-input' }));
  socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(inputs, ['fixture-input']);
  assert.ok(resizes.some(value => value.rows === 40 && value.cols === 120));
  assert.ok(messages.some(message => message.type === 'output' && message.data === 'fixture-output'));

  assert.equal(await rejected(url(ticket), { headers: { Origin: origin, Cookie: 'sid=valid' } }), 401);
  socket.close();
  await waitForEvent(socket, 'close');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closeCount, 1);
});
