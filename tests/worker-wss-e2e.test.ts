/**
 * WSS Worker protocol E2E. Run after npm ci:
 *   npm run build
 *   node --test dist/tests/worker-wss-e2e.test.js
 * The real Go Worker E2E runs in CI or with explicit sandbox opt-in:
 * MCP_WORKER_W2_T03_GO_E2E=1, with a fresh localhost SQLite database.
 * No production deployment, Worker home, public installer, or credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import workerBrokerModule from '../src/services/workerConnectionBroker';
import workerAuthModule from '../src/services/workerAuthService';
import userServiceModule from '../src/services/userService';

const { WorkerConnectionBroker } = workerBrokerModule;
const { WorkerAuthService, canonicalConnectMessage } = workerAuthModule;
const { UserService } = userServiceModule;

function certificate(root: string) {
  const key = path.join(root, 'loopback.key');
  const cert = path.join(root, 'loopback.crt');
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || 'Unable to generate test-only TLS certificate');
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), certPath: cert };
}

function codeIs(value: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === value;
}

async function waitUntil(check: () => boolean, limitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Worker connection did not reach expected state');
}

void test('loopback WSS signs identity, rejects forgery, enforces capacity, and never replays jobs', async (t) => {
  if (spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0) {
    if (process.env.CI === 'true') assert.fail('CI requires OpenSSL for the real WSS handshake');
    t.skip('OpenSSL is required for test-only trusted TLS certificate');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't04-broker-wss-'));
  const tls = certificate(root);
  const keys = crypto.generateKeyPairSync('ed25519');
  const workerId = crypto.randomUUID();
  const record = {
    id: workerId,
    name: 'T04 signed fixture',
    public_key: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    capabilities: ['workspace.exec', 'shell.inspect'],
    enabled: true,
  };
  let heartbeatCount = 0;
  let storageUnavailable = false;
  const repository = {
    findWorkerById(id: string) {
      if (storageUnavailable) return Promise.reject(new Error('fixture identity storage outage'));
      return Promise.resolve(id === workerId ? record : null);
    },
    updateWorkerPresence(id: string, status: string) {
      void id;
      void status;
      return Promise.resolve();
    },
    touchWorker(id: string) {
      void id;
      heartbeatCount += 1;
      return Promise.resolve();
    },
    updateWorkerCapabilities(id: string, caps: string[]) {
      void id;
      record.capabilities = caps;
      return Promise.resolve();
    },
  };
  const auth = new WorkerAuthService({ repository: repository as never });
  const broker = new WorkerConnectionBroker({
    authService: auth,
    repository: repository as never,
    maxPendingGlobal: 1,
    maxPendingPerWorker: 1,
    defaultTimeoutMs: 100,
  });
  const server = https.createServer({ key: tls.key, cert: tls.cert });
  broker.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url =
    'wss://127.0.0.1:' + String((server.address() as AddressInfo).port) + '/worker/v1/connect';
  const sockets: WebSocket[] = [];
  t.after(async () => {
    broker.close();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const signedHeaders = (
    signer = keys.privateKey,
    nonce = crypto.randomBytes(18).toString('base64url'),
  ) => {
    const timestamp = String(Date.now());
    const signature = crypto
      .sign(null, Buffer.from(canonicalConnectMessage({ workerId, timestamp, nonce })), signer)
      .toString('base64');
    return {
      'x-br-worker-id': workerId,
      'x-br-worker-timestamp': timestamp,
      'x-br-worker-nonce': nonce,
      'x-br-worker-signature': signature,
    };
  };
  const forged = crypto.generateKeyPairSync('ed25519');
  const bad = new WebSocket(url, { ca: tls.cert, headers: signedHeaders(forged.privateKey) });
  const denied = await new Promise<number>((resolve, reject) => {
    bad.on('unexpected-response', (_request, response) => {
      const status = response.statusCode || 0;
      response.resume();
      resolve(status);
    });
    bad.on('error', reject);
    bad.on('open', () => reject(new Error('Forged signature accepted')));
  });
  assert.equal(denied, 401);

  // A live WSS upgrade must report storage outages as retryable 503, not permanent 401.
  storageUnavailable = true;
  const unavailable = new WebSocket(url, { ca: tls.cert, headers: signedHeaders() });
  sockets.push(unavailable);
  const storageFailure = await new Promise<{ status: number; code: string }>((resolve, reject) => {
    unavailable.on('unexpected-response', (_request, response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode || 0,
            code: (JSON.parse(body) as { code: string }).code,
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on('error', reject);
    });
    unavailable.on('error', reject);
    unavailable.on('open', () => reject(new Error('Storage outage allowed WSS handshake')));
  });
  storageUnavailable = false;
  assert.deepEqual(storageFailure, { status: 503, code: 'WORKER_STATUS_UNAVAILABLE' });

  let autoReply = true;
  const jobs: string[] = [];
  async function connect(headers = signedHeaders()) {
    const socket = new WebSocket(url, { ca: tls.cert, headers });
    sockets.push(socket);
    socket.on('message', (bytes) => {
      const data = Buffer.isBuffer(bytes)
        ? bytes
        : Array.isArray(bytes)
          ? Buffer.concat(bytes)
          : Buffer.from(bytes);
      const msg = JSON.parse(data.toString('utf8')) as { type?: string; job_id?: string };
      if (msg.type !== 'job' || !msg.job_id) return;
      jobs.push(msg.job_id);
      if (autoReply) {
        socket.send(
          JSON.stringify({
            type: 'result',
            job_id: msg.job_id,
            ok: true,
            result: { stdout: 'T04_TRANSPORT_OK' },
          }),
        );
      }
    });
    await once(socket, 'open');
    await waitUntil(() => broker.isOnline(workerId));
    return socket;
  }
  const headers = signedHeaders();
  let socket = await connect(headers);
  const replay = new WebSocket(url, { ca: tls.cert, headers });
  const replayStatus = await new Promise<number>((resolve, reject) => {
    replay.on('unexpected-response', (_request, response) => {
      const status = response.statusCode || 0;
      response.resume();
      resolve(status);
    });
    replay.on('error', reject);
    replay.on('open', () => reject(new Error('Auth nonce replay accepted')));
  });
  assert.equal(replayStatus, 401);

  assert.deepEqual(await broker.dispatch(workerId, 'workspace.exec', { command: 'true' }), {
    stdout: 'T04_TRANSPORT_OK',
  });
  const probe = await broker.probeConnection(workerId, { timeoutMs: 1000 });
  assert.equal(probe.ok, true);
  socket.send(JSON.stringify({ type: 'heartbeat', capabilities: ['shell.inspect'] }));
  await waitUntil(
    () => heartbeatCount > 0 && broker.connections.get(workerId)?.worker?.capabilities.length === 1,
  );
  assert.deepEqual(record.capabilities, ['workspace.exec', 'shell.inspect']);
  await assert.rejects(
    () => broker.dispatch(workerId, 'workspace.exec', {}),
    codeIs('WORKER_CAPABILITY_DENIED'),
  );
  socket.send(
    JSON.stringify({
      type: 'heartbeat',
      capabilities: ['shell.inspect', 'workspace.exec', 'file.write'],
    }),
  );
  await waitUntil(
    () =>
      broker.connections.get(workerId)?.worker?.capabilities.includes('workspace.exec') === true,
  );
  assert.deepEqual(record.capabilities, ['workspace.exec', 'shell.inspect']);
  await assert.rejects(
    () => broker.dispatch(workerId, 'file.write', {}),
    codeIs('WORKER_CAPABILITY_DENIED'),
  );

  autoReply = false;
  const interrupted = broker.dispatch(workerId, 'workspace.exec', { command: 'no-replay' });
  await waitUntil(() => broker.pending.size === 1);
  await assert.rejects(
    () => broker.dispatch(workerId, 'workspace.exec', {}),
    codeIs('WORKER_BUSY'),
  );
  const countAtDisconnect = jobs.length;
  socket.close();
  await assert.rejects(interrupted, codeIs('WORKER_DISCONNECTED'));
  await waitUntil(() => !broker.isOnline(workerId));
  autoReply = true;
  socket = await connect();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    jobs.length,
    countAtDisconnect,
    'Non-idempotent job must not replay after reconnect',
  );
  assert.deepEqual(await broker.dispatch(workerId, 'workspace.exec', { command: 'true' }), {
    stdout: 'T04_TRANSPORT_OK',
  });

  autoReply = false;
  await assert.rejects(
    () => broker.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 100 }),
    codeIs('WORKER_JOB_TIMEOUT'),
  );
  assert.equal(broker.pending.size, 0);
  broker.disconnect(workerId);
  await waitUntil(() => !broker.isOnline(workerId));
  const silentSocket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    ping() {},
  });
  broker.connections.set(workerId, silentSocket as never);
  const stale = await broker.probeConnection(workerId, { timeoutMs: 250 });
  assert.deepEqual({ ok: stale.ok, reason: stale.reason }, { ok: false, reason: 'probe_timeout' });
  broker.connections.delete(workerId);
  broker.close();
  assert.equal(broker.pending.size, 0);
  assert.equal(broker.connections.size, 0);
});

void test('owner disable revokes an established signed loopback WSS connection and denies reconnect', async (t) => {
  if (spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('OpenSSL is required for disposable local WSS TLS');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-owner-revocation-wss-'));
  const tls = certificate(root);
  const keys = crypto.generateKeyPairSync('ed25519');
  const ownerId = 'fixture-owner-revoke';
  const workerId = crypto.randomUUID();
  let ownerStatus = 'active';
  let ownerLookupUnavailable = false;
  const record = {
    id: workerId,
    owner_user_id: ownerId,
    name: 'Owned test Worker',
    enabled: true,
    public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    capabilities: ['workspace.exec'],
  };
  const workerRepo = {
    findWorkerById: (id: string) => Promise.resolve(id === workerId ? record : null),
    updateWorkerPresence: () => Promise.resolve(),
    touchWorker: () => Promise.resolve(),
    updateWorkerCapabilities: () => Promise.resolve(),
  };
  const ownerStatusLookup = (id: string) =>
    ownerLookupUnavailable
      ? Promise.reject(new Error('disposable owner DB unavailable'))
      : Promise.resolve(id === ownerId ? ownerStatus : null);
  const auth = new WorkerAuthService({
    repository: workerRepo as never,
    ownerStatusLookup,
  });
  const broker = new WorkerConnectionBroker({
    repository: workerRepo as never,
    authService: auth,
    ownerStatusLookup,
  });
  const server = https.createServer({ key: tls.key, cert: tls.cert });
  broker.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url =
    'wss://127.0.0.1:' + String((server.address() as AddressInfo).port) + '/worker/v1/connect';
  const clients: WebSocket[] = [];
  t.after(async () => {
    broker.close();
    for (const client of clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const headers = () => {
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(18).toString('base64url');
    return {
      'x-br-worker-id': workerId,
      'x-br-worker-timestamp': timestamp,
      'x-br-worker-nonce': nonce,
      'x-br-worker-signature': crypto
        .sign(
          null,
          Buffer.from(canonicalConnectMessage({ workerId, timestamp, nonce })),
          keys.privateKey,
        )
        .toString('base64'),
    };
  };
  const client = new WebSocket(url, { ca: tls.cert, headers: headers() });
  clients.push(client);
  await once(client, 'open');
  assert.equal(broker.isOnline(workerId), true);
  const closeEvent = once(client, 'close');
  const ownerUser = { id: ownerId, password_hash: 'fixture-only', status: ownerStatus };
  const userRepo = {
    findById: () => Promise.resolve(ownerUser),
    setStatus: (_id: string, status: string) => {
      ownerStatus = status;
      ownerUser.status = status;
      return Promise.resolve();
    },
  } as unknown as ConstructorParameters<typeof UserService>[0];
  await new UserService(userRepo, broker).setStatus(ownerId, 'disabled');
  const [code] = (await closeEvent) as [number, Buffer];
  assert.equal(code, 4003);
  assert.equal(broker.isOnline(workerId), false);

  const rejected = new WebSocket(url, { ca: tls.cert, headers: headers() });
  clients.push(rejected);
  const httpResponse = await new Promise<{ status: number; code: string }>((resolve, reject) => {
    rejected.on('unexpected-response', (_request, response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode || 0,
            code: (JSON.parse(body) as { code: string }).code,
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on('error', reject);
    });
    rejected.on('error', reject);
    rejected.on('open', () => reject(new Error('Disabled owner was reconnected')));
  });
  assert.deepEqual(httpResponse, { status: 403, code: 'WORKER_OWNER_DISABLED' });

  ownerStatus = 'active';
  ownerLookupUnavailable = true;
  const unavailable = new WebSocket(url, { ca: tls.cert, headers: headers() });
  clients.push(unavailable);
  const unavailableResponse = await new Promise<{ status: number; code: string }>(
    (resolve, reject) => {
      unavailable.on('unexpected-response', (_request, response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode || 0,
              code: (JSON.parse(body) as { code: string }).code,
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        response.on('error', reject);
      });
      unavailable.on('error', reject);
      unavailable.on('open', () => reject(new Error('Owner storage outage accepted reconnect')));
    },
  );
  assert.deepEqual(unavailableResponse, { status: 503, code: 'WORKER_OWNER_UNAVAILABLE' });
});
