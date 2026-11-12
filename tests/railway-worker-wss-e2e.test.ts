/**
 * T04 transport regression. Run after npm ci:
 *   npm run build
 *   node --test dist/tests/railway-worker-wss-e2e.test.js
 * The signed Go Worker E2E in this file runs only in CI or when
 * BOT_REPORT_T04_GO_E2E=1, with a fresh localhost SQLite database.
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

const { WorkerConnectionBroker } = workerBrokerModule;
const { WorkerAuthService, canonicalConnectMessage } = workerAuthModule;

function certificate(root: string) {
  const key = path.join(root, 'loopback.key');
  const cert = path.join(root, 'loopback.crt');
  const result = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', key, '-out', cert, '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || 'Unable to generate test-only TLS certificate');
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), certPath: cert };
}

function codeIs(value: string) {
  return (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === value;
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
  const repository = {
    async findWorkerById(id: string) { return id === workerId ? record : null; },
    async updateWorkerPresence(_id: string, _status: string) {},
    async touchWorker(_id: string) { heartbeatCount += 1; },
    async updateWorkerCapabilities(_id: string, caps: string[]) { record.capabilities = caps; },
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
  broker.attach(server as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'wss://127.0.0.1:' + (server.address() as AddressInfo).port + '/worker/v1/connect';
  const sockets: WebSocket[] = [];
  t.after(async () => {
    broker.close();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const signedHeaders = (signer = keys.privateKey, nonce = crypto.randomBytes(18).toString('base64url')) => {
    const timestamp = String(Date.now());
    const signature = crypto.sign(
      null,
      Buffer.from(canonicalConnectMessage({ workerId, timestamp, nonce })),
      signer,
    ).toString('base64');
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

  let autoReply = true;
  const jobs: string[] = [];
  async function connect(headers = signedHeaders()) {
    const socket = new WebSocket(url, { ca: tls.cert, headers });
    sockets.push(socket);
    socket.on('message', (bytes) => {
      const msg = JSON.parse(bytes.toString()) as { type?: string; job_id?: string };
      if (msg.type !== 'job' || !msg.job_id) return;
      jobs.push(msg.job_id);
      if (autoReply) {
        socket.send(JSON.stringify({
          type: 'result', job_id: msg.job_id, ok: true, result: { stdout: 'T04_TRANSPORT_OK' },
        }));
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

  assert.deepEqual(
    await broker.dispatch(workerId, 'workspace.exec', { command: 'true' }),
    { stdout: 'T04_TRANSPORT_OK' },
  );
  const probe = await broker.probeConnection(workerId, { timeoutMs: 1000 });
  assert.equal(probe.ok, true);
  socket.send(JSON.stringify({ type: 'heartbeat', capabilities: ['shell.inspect'] }));
  await waitUntil(() => heartbeatCount > 0 && record.capabilities.length === 1);
  await assert.rejects(
    () => broker.dispatch(workerId, 'workspace.exec', {}),
    codeIs('WORKER_CAPABILITY_DENIED'),
  );
  socket.send(JSON.stringify({
    type: 'heartbeat', capabilities: ['shell.inspect', 'workspace.exec'],
  }));
  await waitUntil(() => record.capabilities.includes('workspace.exec'));

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
  assert.equal(jobs.length, countAtDisconnect, 'Non-idempotent job must not replay after reconnect');
  assert.deepEqual(
    await broker.dispatch(workerId, 'workspace.exec', { command: 'true' }),
    { stdout: 'T04_TRANSPORT_OK' },
  );

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
