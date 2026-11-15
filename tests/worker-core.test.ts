import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';

import workerAuthService from '../src/services/workerAuthService';
import type { ExecutionTransport } from '../src/services/executionContracts';
const { WorkerAuthService, canonicalConnectMessage } = workerAuthService;
import workerConnectionBroker from '../src/services/workerConnectionBroker';
const { WorkerConnectionBroker } = workerConnectionBroker;
import workerExecutionService from '../src/services/workerExecutionService';
import userServiceModule from '../src/services/userService';
const { UserService } = userServiceModule;
const { WorkerExecutionService } = workerExecutionService;
import terminalMcpService from '../src/services/terminalMcpService';
const { TerminalMcpService } = terminalMcpService;
import lifecycle from '../worker/lifecycle';
import localWorkerCLI from '../worker/cli';
import { stringifyUnknown as appStringifyUnknown } from '../src/utils/stringifyUnknown';
const { buildCleanupPlan, applyCleanupPlan } = lifecycle;

// These fixtures retain the production row and port shapes; only the WebSocket
// transport itself is intentionally partial, because no network is opened.
import type workerRepository from '../src/repositories/workerRepository';
type WorkerRow = NonNullable<Awaited<ReturnType<typeof workerRepository.findWorkerById>>>;
type BrokerOptions = NonNullable<ConstructorParameters<typeof WorkerConnectionBroker>[0]>;
type BrokerRepository = NonNullable<BrokerOptions['repository']>;
type WorkerSocket = Parameters<typeof workerConnectionBroker.handleMessage>[0];
type WorkerRequest = Parameters<typeof workerConnectionBroker.handleConnection>[1];
function requestDouble(worker: WorkerRow): WorkerRequest {
  return { workerAuth: { worker } } as WorkerRequest;
}

function fixtureWorker(
  input: Pick<WorkerRow, 'id' | 'capabilities' | 'enabled'> & Partial<WorkerRow>,
): WorkerRow {
  return {
    name: 'Fixture Worker',
    public_key: '',
    capabilities_json: null,
    status: 'online',
    owner_user_id: null,
    last_seen_at: null,
    ...input,
  };
}
function createBroker(
  options: Omit<BrokerOptions, 'repository'> & { repository?: Partial<BrokerRepository> } = {},
) {
  const repository: BrokerRepository = {
    findWorkerById: () => Promise.resolve(null),
    updateWorkerPresence: () => Promise.resolve(),
    touchWorker: () => Promise.resolve(),
    updateWorkerCapabilities: () => Promise.resolve(),
    ...options.repository,
  };
  return new WorkerConnectionBroker({ ...options, repository });
}
function parseDispatchedJob(raw: string): { type: string; job_id: string; operation: string } {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('type' in parsed) ||
    typeof parsed.type !== 'string' ||
    !('job_id' in parsed) ||
    typeof parsed.job_id !== 'string'
  ) {
    throw new Error('Invalid fake worker dispatch message');
  }
  return {
    type: parsed.type,
    job_id: parsed.job_id,
    operation:
      'operation' in parsed && typeof parsed.operation === 'string' ? parsed.operation : '',
  };
}
function socketDouble<T extends { workerId: string; readyState: number }>(
  value: T,
): T & WorkerSocket {
  // TypeScript's full ws interface cannot be structurally implemented by a
  // deliberately minimal no-I/O fake. Its exercised members remain checked.
  return value as T & WorkerSocket;
}

void test('worker enrollment normalizes capabilities and signed handshake rejects replay', async () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let storedWorker: WorkerRow | null = null;
  let consumed = false;
  const repository = {
    consumeEnrollmentToken(token: string) {
      assert.equal(token, 'br_enroll_fixture');
      if (consumed)
        return Promise.reject(
          Object.assign(new Error('used'), { code: 'WORKER_ENROLLMENT_INVALID', status: 401 }),
        );
      consumed = true;
      return Promise.resolve({
        id: 'fixture-enrollment',
        owner_user_id: null,
        used_at: new Date().toISOString(),
      });
    },
    createWorker({
      name,
      publicKey: normalized,
      capabilities,
    }: {
      name: string;
      publicKey: string;
      capabilities: string[];
    }) {
      storedWorker = fixtureWorker({
        id: crypto.randomUUID(),
        name,
        public_key: normalized,
        capabilities,
        enabled: true,
      });
      return Promise.resolve(storedWorker);
    },
    findWorkerById(id: string) {
      return Promise.resolve(storedWorker?.id === id ? storedWorker : null);
    },
  };
  const now = 1_800_000_000_000;
  const service = new WorkerAuthService({ repository, now: () => now });
  const worker = await service.enroll({
    token: 'br_enroll_fixture',
    name: 'Dev Worker',
    publicKey,
    capabilities: ['workspace.exec', 'tmux.inspect', 'workspace.exec', 'unknown'],
  });
  assert.ok(worker);
  assert.deepEqual(worker.capabilities, ['tmux.inspect', 'workspace.exec']);

  const timestamp = String(now);
  const nonce = 'nonce_abcdefghijklmnop';
  const signature = crypto
    .sign(
      null,
      Buffer.from(canonicalConnectMessage({ workerId: worker.id, timestamp, nonce }), 'utf8'),
      pair.privateKey,
    )
    .toString('base64');
  const headers = {
    'x-br-worker-id': worker.id,
    'x-br-worker-timestamp': timestamp,
    'x-br-worker-nonce': nonce,
    'x-br-worker-signature': signature,
  };
  assert.equal((await service.authenticateConnect(headers)).id, worker.id);
  await assert.rejects(
    () => service.authenticateConnect(headers),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_AUTH_REPLAY',
  );

  const activeWorker = storedWorker as { enabled: boolean } | null;
  if (!activeWorker) throw new Error('Worker was not stored by fixture repository');
  activeWorker.enabled = false;
  const disabledNonce = 'nonce_disabled_abcdefghijk';
  const disabledSignature = crypto
    .sign(
      null,
      Buffer.from(
        canonicalConnectMessage({ workerId: worker.id, timestamp, nonce: disabledNonce }),
        'utf8',
      ),
      pair.privateKey,
    )
    .toString('base64');
  await assert.rejects(
    () =>
      service.authenticateConnect({
        ...headers,
        'x-br-worker-nonce': disabledNonce,
        'x-br-worker-signature': disabledSignature,
      }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_DISABLED',
  );
});

void test('signed Worker handshake rejects disabled or missing owner after signature validation', async () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const workerId = 'owned-worker-fixture';
  const worker = fixtureWorker({
    id: workerId,
    enabled: true,
    owner_user_id: 'user-owner-a',
    public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    capabilities: ['workspace.exec'],
  });
  const repository = {
    findWorkerById: (id: string) => Promise.resolve(id === workerId ? worker : null),
    consumeEnrollmentToken: () => Promise.reject(new Error('enrollment not involved')),
    createWorker: () => Promise.reject(new Error('creation not involved')),
  };
  const now = 1_800_000_000_000;
  let ownerState: string | null = 'disabled';
  let storageFails = false;
  let ownerLookups = 0;
  const service = new WorkerAuthService({
    repository,
    now: () => now,
    ownerStatusLookup: (id: string) => {
      assert.equal(id, 'user-owner-a');
      ownerLookups++;
      if (storageFails) return Promise.reject(new Error('test-only storage unavailable'));
      return Promise.resolve(ownerState);
    },
  });
  function signedHeaders(nonce: string) {
    const timestamp = String(now);
    return {
      'x-br-worker-id': workerId,
      'x-br-worker-timestamp': timestamp,
      'x-br-worker-nonce': nonce,
      'x-br-worker-signature': crypto
        .sign(
          null,
          Buffer.from(canonicalConnectMessage({ workerId, timestamp, nonce })),
          pair.privateKey,
        )
        .toString('base64'),
    };
  }
  const invalidSignature = {
    ...signedHeaders('nonce_owner_invalid_012345'),
    'x-br-worker-signature': Buffer.alloc(64).toString('base64'),
  };
  await assert.rejects(
    service.authenticateConnect(invalidSignature),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_AUTH_INVALID',
  );
  assert.equal(ownerLookups, 0, 'Do not disclose owner state before signature verification');

  await assert.rejects(
    service.authenticateConnect(signedHeaders('nonce_owner_disabled_012345')),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_OWNER_DISABLED',
  );
  ownerState = null;
  await assert.rejects(
    service.authenticateConnect(signedHeaders('nonce_owner_missing_012345')),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_OWNER_DISABLED',
  );
  storageFails = true;
  await assert.rejects(
    service.authenticateConnect(signedHeaders('nonce_owner_dberror_012345')),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_OWNER_UNAVAILABLE',
  );
  storageFails = false;
  ownerState = 'active';
  assert.equal(
    (await service.authenticateConnect(signedHeaders('nonce_owner_active_012345'))).id,
    workerId,
  );
  // NULL ownership denotes an administrator-owned Worker, not a missing user.
  worker.owner_user_id = null;
  storageFails = true;
  const previousLookups = ownerLookups;
  assert.equal(
    (await service.authenticateConnect(signedHeaders('nonce_admin_owned_012345'))).id,
    workerId,
  );
  assert.equal(ownerLookups, previousLookups);
});

void test('worker broker dispatch correlates typed result and fails closed on missing capability', async () => {
  const workerId = crypto.randomUUID();
  const workerRecord = fixtureWorker({
    id: workerId,
    capabilities: ['workspace.exec'],
    enabled: true,
  });
  const broker = createBroker({
    repository: {
      findWorkerById: (id: string) => Promise.resolve(id === workerId ? workerRecord : null),
    },
    defaultTimeoutMs: 1000,
  });
  const dispatched: { value: { type: string; operation: string; job_id: string } | null } = {
    value: null,
  };
  const ws = socketDouble({
    workerId,
    worker: workerRecord,
    readyState: WebSocket.OPEN,
    send(text: string) {
      dispatched.value = parseDispatchedJob(text);
    },
  });
  broker.connections.set(workerId, ws);
  const pending = broker.dispatch(
    workerId,
    'workspace.exec',
    { command: 'printf ok' },
    { timeoutMs: 1000 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const outbound = dispatched.value;
  if (!outbound) throw new Error('Worker dispatch mock did not send');
  assert.equal(outbound.type, 'job');
  assert.equal(outbound.operation, 'workspace.exec');
  broker.handleMessage(
    ws,
    JSON.stringify({
      type: 'result',
      job_id: outbound.job_id,
      ok: true,
      result: { exit_code: 0, stdout: 'ok' },
    }),
  );
  assert.deepEqual(await pending, { exit_code: 0, stdout: 'ok' });
  await assert.rejects(
    () => broker.dispatch(workerId, 'file.write', {}, { timeoutMs: 100 }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_CAPABILITY_DENIED',
  );
  broker.close();
});

void test('worker heartbeat cannot grant capabilities and preserves presence updates', async () => {
  const workerId = crypto.randomUUID();
  const writes: Array<{ id: string; capabilities: string[] }> = [];
  let presenceTouches = 0;
  const broker = createBroker({
    repository: {
      updateWorkerCapabilities(id: string, capabilities: unknown[]) {
        writes.push({
          id,
          capabilities: capabilities.filter((x): x is string => typeof x === 'string'),
        });
        return Promise.resolve();
      },
      touchWorker(id: string) {
        assert.equal(id, workerId);
        presenceTouches += 1;
        return Promise.resolve();
      },
    },
  });
  const ws = socketDouble({
    workerId,
    worker: { id: workerId, capabilities: ['workspace.exec'] },
    readyState: WebSocket.OPEN,
    send() {},
    close() {},
  });
  broker.connections.set(workerId, ws);
  broker.handleMessage(ws, JSON.stringify({ type: 'heartbeat', capabilities: ['workspace.exec'] }));
  broker.handleMessage(ws, JSON.stringify({ type: 'heartbeat', capabilities: ['workspace.exec'] }));
  broker.handleMessage(
    ws,
    JSON.stringify({ type: 'heartbeat', capabilities: ['file.write', 'workspace.exec'] }),
  );
  broker.handleMessage(
    ws,
    JSON.stringify({ type: 'heartbeat', capabilities: ['workspace.exec', 'file.write'] }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presenceTouches, 4);
  assert.deepEqual(writes, [], 'A Worker heartbeat is not a grant authority');
  assert.deepEqual(ws.worker.capabilities, ['workspace.exec']);
  broker.close();
});

void test('late close and result from a replaced Worker socket cannot affect the current connection', async () => {
  const workerId = crypto.randomUUID();
  const worker = fixtureWorker({ id: workerId, enabled: true, capabilities: ['workspace.exec'] });
  const presence: string[] = [];
  const broker = createBroker({
    repository: {
      findWorkerById() {
        return Promise.resolve(worker);
      },
      updateWorkerPresence(_id: string, status: string) {
        presence.push(status);
        return Promise.resolve();
      },
    },
    defaultTimeoutMs: 1_000,
  });
  const socket = () => {
    const listeners: Record<string, (() => void) | undefined> = {};
    return socketDouble({
      workerId,
      worker: { ...worker },
      readyState: Number(WebSocket.OPEN),
      sent: [] as Array<{ type: string; job_id: string }>,
      on(name: string, callback: () => void) {
        listeners[name] = callback;
      },
      send(text: string) {
        this.sent.push(parseDispatchedJob(text));
      },
      close() {
        this.readyState = WebSocket.CLOSED;
        listeners.close?.();
      },
      triggerClose() {
        listeners.close?.();
      },
    });
  };
  const first = socket();
  broker.handleConnection(first, requestDouble(worker));
  const abandoned = broker.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 1_000 });
  await new Promise((resolve) => setImmediate(resolve));
  const firstJob = first.sent.find((message) => message.type === 'job');
  assert.ok(firstJob);

  const second = socket();
  broker.handleConnection(second, requestDouble(worker));
  await assert.rejects(
    abandoned,
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_DISCONNECTED',
  );
  assert.equal(broker.isOnline(workerId), true);
  assert.deepEqual(presence, ['online', 'online']);

  const current = broker.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 1_000 });
  await new Promise((resolve) => setImmediate(resolve));
  const currentJob = second.sent.find((message) => message.type === 'job');
  assert.ok(currentJob);
  broker.handleMessage(
    first,
    JSON.stringify({
      type: 'result',
      job_id: currentJob.job_id,
      ok: true,
      result: { stale: true },
    }),
  );
  first.triggerClose();
  assert.equal(broker.pending.has(currentJob.job_id), true);
  assert.equal(broker.isOnline(workerId), true);
  assert.deepEqual(presence, ['online', 'online']);

  broker.handleMessage(
    second,
    JSON.stringify({
      type: 'result',
      job_id: currentJob.job_id,
      ok: true,
      result: { current: true },
    }),
  );
  assert.deepEqual(await current, { current: true });
  broker.close();
});

void test('stale heartbeat expires an established connection and pending job', async () => {
  const workerId = crypto.randomUUID();
  const worker = fixtureWorker({ id: workerId, enabled: true, capabilities: ['workspace.exec'] });
  const statuses: string[] = [];
  const broker = createBroker({
    repository: {
      findWorkerById: () => Promise.resolve(worker),
      updateWorkerPresence(_id: string, status: string) {
        statuses.push(status);
        return Promise.resolve();
      },
    },
  });
  const ws = socketDouble({
    readyState: Number(WebSocket.OPEN),
    workerId,
    worker: { ...worker },
    lastHeartbeatAt: 0,
    closeCode: 0,
    on() {},
    send() {},
    close(code: number) {
      this.closeCode = code;
      this.readyState = WebSocket.CLOSED;
    },
  });
  broker.handleConnection(ws, requestDouble(worker));
  const pending = broker.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 1_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.pending.size, 1);
  const elapsed = Date.now();
  ws.lastHeartbeatAt = elapsed - 76_000;
  broker.expireStaleConnections(elapsed);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_DISCONNECTED',
  );
  assert.equal(ws.closeCode, 4002);
  assert.equal(broker.isOnline(workerId), false);
  assert.deepEqual(statuses, ['online', 'offline']);
  assert.equal(broker.pending.size, 0);
  broker.close();
});

void test('Worker broker limits regular jobs but reserves slots for lifecycle control', async () => {
  const workerId = crypto.randomUUID();
  const worker = fixtureWorker({ id: workerId, capabilities: ['workspace.exec'], enabled: true });
  const broker = createBroker({
    repository: { findWorkerById: () => Promise.resolve(worker) },
    maxPendingGlobal: 1,
    maxPendingPerWorker: 1,
    maxControlGlobal: 1,
    maxControlPerWorker: 1,
    maxBufferedBytes: 32,
  });
  const sent: Array<{ type: string; job_id: string }> = [];
  const ws = socketDouble({
    workerId,
    worker,
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(raw: string) {
      sent.push(parseDispatchedJob(raw));
    },
    close() {},
  });
  broker.connections.set(workerId, ws);
  const job = broker.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => broker.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 1000 }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'WORKER_BUSY' &&
      'status' in error &&
      error.status === 429,
  );

  const cleanup = broker.dispatchControl(
    workerId,
    'worker.self_uninstall',
    {},
    { timeoutMs: 1000 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.filter((item) => item.type === 'job').length, 2);
  await assert.rejects(
    () => broker.dispatchControl(workerId, 'worker.self_uninstall', {}, { timeoutMs: 1000 }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'WORKER_BUSY' &&
      'status' in error &&
      error.status === 429,
  );

  for (const dispatched of sent) {
    if (dispatched.type === 'job')
      broker.handleMessage(
        ws,
        JSON.stringify({
          type: 'result',
          job_id: dispatched.job_id,
          ok: true,
          result: { ok: true },
        }),
      );
  }
  assert.deepEqual(await job, { ok: true });
  assert.deepEqual(await cleanup, { ok: true });
  assert.equal(broker.pending.size, 0);

  ws.bufferedAmount = 32;
  await assert.rejects(
    () => broker.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 1000 }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'WORKER_BACKPRESSURE' &&
      'status' in error &&
      error.status === 429,
  );
  broker.close();
});

void test('Worker broker bounds streams and rejects input while transport buffer is saturated', async () => {
  const workerId = crypto.randomUUID();
  const worker = fixtureWorker({ id: workerId, capabilities: ['shell.attach'], enabled: true });
  const broker = createBroker({
    repository: { findWorkerById: () => Promise.resolve(worker) },
    maxStreamsGlobal: 1,
    maxStreamsPerWorker: 1,
    maxBufferedBytes: 32,
  });
  const ws = socketDouble({
    workerId,
    worker,
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send() {},
    close() {},
  });
  broker.connections.set(workerId, ws);
  const stream = await broker.openStream(workerId, 'shell.attach', {});
  await assert.rejects(
    () => broker.openStream(workerId, 'shell.attach', {}),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'WORKER_BUSY' &&
      'status' in error &&
      error.status === 429,
  );
  ws.bufferedAmount = 32;
  assert.throws(
    () => stream.input('x'),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'WORKER_BACKPRESSURE' &&
      'status' in error &&
      error.status === 429,
  );
  stream.close();
  assert.equal(broker.streams.size, 0);
  await assert.rejects(
    () => broker.openStream(workerId, 'shell.attach', {}),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'WORKER_BACKPRESSURE' &&
      'status' in error &&
      error.status === 429,
  );
  broker.close();
});

void test('worker broker forwards authenticated memory emergency alerts to the Owner notifier', async () => {
  const workerId = crypto.randomUUID();
  const alerts: Array<{
    workerId?: string;
    workerName: string;
    memoryUsedPercent: number;
    phase: string;
    stopped: Record<string, number>;
  }> = [];
  const broker = createBroker({
    repository: { findWorkerById: () => Promise.resolve(null) },
    notifier: {
      sendWorkerResourceAlert(alert: {
        workerId?: string;
        workerName: string;
        memoryUsedPercent: number;
        phase: string;
        stopped: Record<string, number>;
      }) {
        alerts.push(alert);
        return Promise.resolve({ sent: true });
      },
    },
  });
  const ws = socketDouble({
    workerId,
    worker: { id: workerId, name: 'VPS Worker', capabilities: [], enabled: true },
    readyState: WebSocket.OPEN,
  });
  broker.connections.set(workerId, ws);
  broker.handleMessage(
    ws,
    JSON.stringify({
      type: 'resource_alert',
      code: 'WORKER_MEMORY_EMERGENCY',
      severity: 'critical',
      phase: 'task_running',
      memory_used_percent: 91.4,
      memory_total_bytes: 4 * 1024 * 1024 * 1024,
      memory_available_bytes: 350 * 1024 * 1024,
      threshold_percent: 90,
      resume_percent: 85,
      stopped: { workspace_commands: 1, managed_processes: 2, shell_sessions: 1 },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].workerId, workerId);
  assert.equal(alerts[0].workerName, 'VPS Worker');
  assert.equal(alerts[0].memoryUsedPercent, 91.4);
  assert.equal(alerts[0].phase, 'task_running');
  assert.deepEqual(alerts[0].stopped, {
    workspace_commands: 1,
    managed_processes: 2,
    shell_sessions: 1,
  });
  broker.close();
});

void test('worker execution service maps the existing execution interface to typed worker jobs', async () => {
  const calls: Array<{
    workerId: string;
    operation: string;
    payload: Record<string, unknown>;
    options: unknown;
  }> = [];
  const broker = {
    dispatch<T>(
      workerId: string,
      operation: string,
      payload: Record<string, unknown>,
      options: unknown,
    ) {
      calls.push({ workerId, operation, payload, options });
      if (operation === 'shell.inspect')
        return Promise.resolve({
          pane_count: 1,
          target_pane: 'shell',
          pane_current_command: 'bash',
        } as T);
      if (operation === 'workspace.exec')
        return Promise.resolve({
          exit_code: 0,
          stdout: 'ok',
          stderr: '',
          duration_ms: 1,
          stdout_truncated: false,
          stderr_truncated: false,
        } as T);
      return Promise.resolve({ code: 'OK' } as T);
    },
  };
  const service = new WorkerExecutionService({ broker });
  const profile = { id: 'profile-1', worker_id: 'worker-1' };
  const inspection = await service.inspectProfile(profile);
  assert.equal(inspection.target_pane, 'shell');
  assert.equal(calls[0].payload.session_key, 'profile:profile-1');
  const exec = await service.execWorkspaceCommand(profile, null, 'printf ok', {
    cwd: '/work',
    timeoutMs: 5000,
  });
  assert.equal(exec.stdout, 'ok');
  assert.deepEqual(
    calls.map((call) => call.operation),
    ['shell.inspect', 'workspace.exec'],
  );
  assert.equal(calls[1].payload.cwd, '/work');
});

void test('Worker local roots default to unrestricted but explicit roots remain supported', () => {
  assert.deepEqual(localWorkerCLI.normalizeRoots(''), []);
  assert.deepEqual(localWorkerCLI.normalizeRoots('   '), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-cli-roots-'));
  try {
    assert.deepEqual(localWorkerCLI.normalizeRoots(root), [root]);
    assert.deepEqual(localWorkerCLI.normalizeRoots(`${root},${root}`), [root]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test('Node Worker honors OS-permitted file and shell paths without configured roots', () => {
  if (process.platform === 'win32') return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-unrestricted-'));
  const restrictedRoot = path.join(base, 'restricted');
  const outsideRoot = path.join(base, 'outside');
  fs.mkdirSync(restrictedRoot);
  fs.mkdirSync(outsideRoot);
  const target = path.join(outsideRoot, 'new', 'note.txt');
  const script = `
    const agent = require(process.env.FIXTURE_AGENT_MODULE);
    (async () => {
      await agent.executeOperation('file.write', {
        path: process.env.FIXTURE_TARGET, content: 'OS-allowed-file', create_dirs: true
      });
      const file = await agent.executeOperation('artifact.collect', {
        path: process.env.FIXTURE_TARGET
      });
      const shell = await agent.executeOperation('workspace.exec', {
        command: 'printf OS-allowed-shell', cwd: process.env.FIXTURE_CWD
      });
      process.stdout.write(JSON.stringify({ file: file.text, stdout: shell.stdout, code: shell.exit_code }));
    })().catch(error => {
      process.stdout.write(JSON.stringify({ error: error.code || String(error) }));
    });
  `;
  try {
    const agentPath = require.resolve('../worker/agent');
    const env = {
      ...process.env,
      BOT_REPORT_WORKER_ALLOWED_ROOTS: '',
      BOT_REPORT_WORKER_ALLOW_SHELL: 'true',
      FIXTURE_AGENT_MODULE: agentPath,
      FIXTURE_TARGET: target,
      FIXTURE_CWD: outsideRoot,
    };
    const success = spawnSync(process.execPath, ['-e', script], {
      cwd: base,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(success.stdout), {
      file: 'OS-allowed-file',
      stdout: 'OS-allowed-shell',
      code: 0,
    });
    const restricted = spawnSync(process.execPath, ['-e', script], {
      cwd: base,
      env: { ...env, BOT_REPORT_WORKER_ALLOWED_ROOTS: restrictedRoot },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(restricted.status, 0, restricted.stderr);
    assert.deepEqual(JSON.parse(restricted.stdout), { error: 'WORKER_PATH_DENIED' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'OS-allowed-file');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

void test('local worker uninstall removes only verified installer-managed files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-report-worker-cleanup-'));
  const installRoot = path.join(dir, 'share', 'bot-report-worker');
  const runtimeDir = path.join(installRoot, 'current');
  const workerHome = path.join(dir, '.bot-report-worker');
  const binDir = path.join(dir, 'bin');
  const binPath = path.join(binDir, 'bot-report-worker');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(workerHome, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'cli.js'), '#!/usr/bin/env node\n');
  fs.symlinkSync(path.join(runtimeDir, 'cli.js'), binPath);
  fs.writeFileSync(path.join(workerHome, 'install-root'), `${installRoot}\n`);
  fs.writeFileSync(path.join(workerHome, 'bin-path'), `${binPath}\n`);
  fs.writeFileSync(
    path.join(workerHome, 'config.json'),
    JSON.stringify({ tmux_created_by_worker: false }),
  );

  const plan = buildCleanupPlan({ runtimeDir, workerHome });
  assert.equal(plan.install_root, installRoot);
  assert.equal(plan.remove_bin, true);
  const result = applyCleanupPlan(plan);
  assert.equal(result.code, 'UNINSTALLED');
  assert.equal(fs.existsSync(workerHome), false);
  assert.equal(fs.existsSync(installRoot), false);
  assert.equal(fs.existsSync(binPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

void test('MCP execution profile routes worker profiles without decrypting an SSH password', async () => {
  const profile = {
    id: crypto.randomUUID(),
    name: 'Worker Dev',
    description: 'worker target',
    worker_id: crypto.randomUUID(),
    worker_name: 'Laptop',
    worker_status: 'online',
    tmux_session: 'main',
    enabled: true,
    transport: 'worker' as const,
  };
  const worker = {
    inspectProfile() {
      return Promise.resolve({
        pane_count: 1,
        target_pane: '%1',
        pane_current_command: 'bash',
        panes: [{ id: '%1', current_command: 'bash' }],
      });
    },
    execWorkspaceCommand(_profile: unknown, password: string | null, command: string) {
      assert.equal(password, null);
      assert.equal(command, 'printf ok');
      return Promise.resolve({
        exit_code: 0,
        stdout: 'ok',
        stderr: '',
        duration_ms: 2,
        stdout_truncated: false,
        stderr_truncated: false,
      });
    },
  };
  const service = new TerminalMcpService({
    profiles: {
      findAll: () => Promise.resolve([profile]),
    },
    worker: worker as unknown as ExecutionTransport,
    audit: { log: () => Promise.resolve({ changes: 0, insertId: null }) },
  });
  const status = await service.status('Worker Dev');
  assert.equal(status.status, 'READY');
  const result = await service.workspaceExec('Worker Dev', 'printf ok', { cwd: '/work' });
  assert.equal(result.stdout, 'ok');
});

void test('dispatch and stream reject a socket replaced after owner verification', async () => {
  const worker = fixtureWorker({
    id: 'owner-verify-socket-race',
    owner_user_id: 'owner-a',
    enabled: true,
    capabilities: ['workspace.exec', 'shell.attach'],
  });
  for (const operation of ['dispatch', 'stream'] as const) {
    let finishOwnerLookup: ((status: string) => void) | undefined;
    let sentToOldSocket = 0;
    const broker = createBroker({
      repository: { findWorkerById: () => Promise.resolve(worker) },
      ownerStatusLookup: () =>
        new Promise<string>((resolve) => {
          finishOwnerLookup = resolve;
        }),
    });
    const makeSocket = (old: boolean) =>
      socketDouble({
        workerId: worker.id,
        worker,
        readyState: Number(WebSocket.OPEN),
        on() {},
        close() {},
        send(raw: string) {
          const message = JSON.parse(raw) as { type?: string };
          if (old && ['job', 'stream_open'].includes(message.type || '')) {
            sentToOldSocket++;
            throw new Error('stale socket was sent a command');
          }
        },
      });
    const first = makeSocket(true);
    const second = makeSocket(false);
    broker.handleConnection(first, requestDouble(worker));
    const inFlight =
      operation === 'dispatch'
        ? broker.dispatch(worker.id, 'workspace.exec', {})
        : broker.openStream(worker.id, 'shell.attach', {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(finishOwnerLookup, 'owner verification must be pending');

    finishOwnerLookup('active');
    // The owner check resumes before this replacement; the caller resumes after it.
    queueMicrotask(() =>
      queueMicrotask(() => broker.handleConnection(second, requestDouble(worker))),
    );
    await assert.rejects(
      inFlight,
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'WORKER_DISCONNECTED',
      `superseded socket must reject ${operation}`,
    );
    assert.equal(sentToOldSocket, 0, `no ${operation} may reach the replaced socket`);
    assert.equal(broker.isOnline(worker.id), true, 'replacement socket stays connected');
    broker.close();
  }
});

void test('dispatch rejects a socket replaced during asynchronous Worker lookup', async () => {
  const workerId = crypto.randomUUID();
  const worker = fixtureWorker({ id: workerId, enabled: true, capabilities: ['workspace.exec'] });
  let completeLookup: (value: WorkerRow | null) => void = () => {};
  const broker = createBroker({
    repository: {
      findWorkerById: () =>
        new Promise<WorkerRow | null>((resolve) => {
          completeLookup = resolve;
        }),
    },
    defaultTimeoutMs: 100,
  });
  let sent = 0;
  const first = socketDouble({
    workerId,
    worker,
    readyState: WebSocket.OPEN,
    send() {
      sent++;
    },
    close() {},
  });
  const second = socketDouble({
    workerId,
    worker,
    readyState: WebSocket.OPEN,
    send() {},
    close() {},
  });
  broker.connections.set(workerId, first);
  const job = broker.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 100 });
  broker.connections.set(workerId, second);
  completeLookup(worker);
  await assert.rejects(
    job,
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_DISCONNECTED',
  );
  assert.equal(sent, 0);
  assert.equal(broker.pending.size, 0);
  broker.close();
});

void test('openStream rejects a socket replaced during asynchronous Worker lookup', async () => {
  const workerId = crypto.randomUUID();
  const worker = fixtureWorker({ id: workerId, enabled: true, capabilities: ['shell.attach'] });
  let finish: (value: WorkerRow | null) => void = () => {};
  const broker = createBroker({
    repository: {
      findWorkerById: () =>
        new Promise<WorkerRow | null>((resolve) => {
          finish = resolve;
        }),
    },
  });
  let sent = 0;
  const first = socketDouble({
    workerId,
    worker,
    readyState: WebSocket.OPEN,
    send() {
      sent++;
    },
    close() {},
  });
  const second = socketDouble({ ...first });
  broker.connections.set(workerId, first);
  const opening = broker.openStream(workerId, 'shell.attach', {});
  broker.connections.set(workerId, second);
  finish(worker);
  await assert.rejects(
    opening,
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_DISCONNECTED',
  );
  assert.equal(sent, 0);
  assert.equal(broker.streams.size, 0);
  broker.close();
});

void test('disabling a user evicts their live Worker sockets and in-flight jobs only after persistence', async () => {
  const ownerId = 'fixture-owner-a';
  let ownerStatus = 'active';
  const rows = [
    fixtureWorker({
      id: 'owned-a-1',
      owner_user_id: ownerId,
      enabled: true,
      capabilities: ['workspace.exec'],
    }),
    fixtureWorker({
      id: 'owned-b-1',
      owner_user_id: 'fixture-owner-b',
      enabled: true,
      capabilities: ['workspace.exec'],
    }),
    fixtureWorker({
      id: 'admin-owned-1',
      owner_user_id: null,
      enabled: true,
      capabilities: ['workspace.exec'],
    }),
  ];
  const broker = createBroker({
    repository: {
      findWorkerById: (id: string) => Promise.resolve(rows.find((row) => row.id === id) ?? null),
    },
    ownerStatusLookup: (id: string) => Promise.resolve(id === ownerId ? ownerStatus : 'active'),
  });
  const sockets = rows.map((worker) => {
    const ws = socketDouble({
      workerId: worker.id,
      worker,
      readyState: Number(WebSocket.OPEN),
      closeCode: 0,
      sent: [] as string[],
      send(data: string) {
        this.sent.push(data);
      },
      on() {},
      close(code: number) {
        this.closeCode = code;
        this.readyState = WebSocket.CLOSED;
      },
    });
    broker.handleConnection(ws, requestDouble(worker));
    return ws;
  });
  const pending = broker.dispatch(rows[0].id, 'workspace.exec', {}, { timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.pending.size, 1);

  const userRecord = { id: ownerId, status: 'active', password_hash: 'fixture-only' };
  const repo = {
    findById: () => Promise.resolve(userRecord),
    setStatus: (_id: string, status: string) => {
      ownerStatus = status;
      userRecord.status = status;
      assert.equal(broker.isOnline(rows[0].id), true, 'revocation must follow persisted disable');
      return Promise.resolve();
    },
  } as unknown as ConstructorParameters<typeof UserService>[0];
  const userService = new UserService(repo, broker);
  await userService.setStatus(ownerId, 'disabled');
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_DISCONNECTED',
  );
  assert.equal(sockets[0].closeCode, 4003);
  assert.equal(broker.isOnline(rows[0].id), false);
  assert.equal(broker.pending.size, 0);
  assert.equal(broker.isOnline(rows[1].id), true, "other owner's Worker remains online");
  assert.equal(broker.isOnline(rows[2].id), true, 'admin-owned Worker remains online');
  broker.close();
});

void test('a live WSS connection is evicted when an external owner status check fails closed', async () => {
  const worker = fixtureWorker({
    id: 'owned-background-check',
    owner_user_id: 'fixture-owner-c',
    enabled: true,
    capabilities: ['workspace.exec', 'shell.attach'],
  });
  let status: string | null = 'active';
  let lookupFails = false;
  const broker = createBroker({
    repository: { findWorkerById: () => Promise.resolve(worker) },
    ownerStatusLookup: () =>
      lookupFails
        ? Promise.reject(new Error('temporary fixture DB outage'))
        : Promise.resolve(status),
  });
  function makeSocket() {
    return socketDouble({
      workerId: worker.id,
      worker,
      readyState: Number(WebSocket.OPEN),
      closeCode: 0,
      jobsSent: 0,
      on() {},
      send(data: string) {
        const parsed = JSON.parse(data) as { type?: string };
        if (parsed.type === 'job') this.jobsSent++;
      },
      close(code: number) {
        this.closeCode = code;
        this.readyState = WebSocket.CLOSED;
      },
    });
  }
  const first = makeSocket();
  broker.handleConnection(first, requestDouble(worker));
  status = 'disabled'; // Another instance updated the DB, bypassing UserService.
  await broker.revalidateOwners();
  assert.equal(first.closeCode, 4003);
  assert.equal(broker.isOnline(worker.id), false);

  const second = makeSocket();
  broker.handleConnection(second, requestDouble(worker));
  await assert.rejects(
    broker.dispatch(worker.id, 'workspace.exec', {}, { timeoutMs: 100 }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_OWNER_DISABLED',
  );
  assert.equal(second.jobsSent, 0, 'no operation can start under a disabled owner');

  status = 'active';
  lookupFails = true;
  const third = makeSocket();
  broker.handleConnection(third, requestDouble(worker));
  await assert.rejects(
    broker.openStream(worker.id, 'shell.attach', {}),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_OWNER_UNAVAILABLE',
  );
  assert.equal(third.closeCode, 4003, 'unavailable owner DB must not leave a live socket');
  assert.equal(broker.streams.size, 0);
  broker.close();
});

void test('external Worker disable, removal, reassignment and storage errors revoke live sockets', async () => {
  const identity = fixtureWorker({
    id: 'fixture-external-identity',
    owner_user_id: 'owner-original',
    enabled: true,
    capabilities: ['workspace.exec'],
  });
  for (const scenario of [
    { name: 'unchanged', state: 'active', closeCode: 0, closeReason: '' },
    { name: 'disabled', state: 'disabled', closeCode: 4003, closeReason: 'worker-disabled' },
    { name: 'removed', state: 'removed', closeCode: 4004, closeReason: 'worker-removed' },
    {
      name: 'capability-revoked',
      state: 'capability-revoked',
      closeCode: 4003,
      closeReason: 'worker-capability-revoked',
    },
    { name: 'capability-added', state: 'capability-added', closeCode: 0, closeReason: '' },
    {
      name: 'reassigned',
      state: 'reassigned',
      closeCode: 4003,
      closeReason: 'worker-identity-changed',
    },
    {
      name: 'key-rotated',
      state: 'key-rotated',
      closeCode: 4003,
      closeReason: 'worker-identity-changed',
    },
    {
      name: 'database-unavailable',
      state: 'unavailable',
      closeCode: 4003,
      closeReason: 'worker-status-unavailable',
    },
  ] as const) {
    let current: WorkerRow | null = identity;
    if (scenario.state === 'disabled') current = { ...identity, enabled: false };
    if (scenario.state === 'removed') current = null;
    if (scenario.state === 'reassigned') current = { ...identity, owner_user_id: 'new-owner' };
    if (scenario.state === 'key-rotated') current = { ...identity, public_key: 'rotated-key' };
    if (scenario.state === 'capability-revoked') current = { ...identity, capabilities: [] };
    if (scenario.state === 'capability-added')
      current = { ...identity, capabilities: ['workspace.exec', 'file.read'] };
    const broker = createBroker({
      repository: {
        findWorkerById: () =>
          scenario.state === 'unavailable'
            ? Promise.reject(new Error('fixture database unavailable'))
            : Promise.resolve(current),
      },
    });
    const ws = socketDouble({
      workerId: identity.id,
      worker: identity,
      readyState: Number(WebSocket.OPEN),
      closeCode: 0,
      closeReason: '',
      on() {},
      send() {},
      close(code: number, reason: string) {
        this.closeCode = code;
        this.closeReason = reason;
        this.readyState = WebSocket.CLOSED;
      },
    });
    broker.handleConnection(ws, requestDouble(identity));
    await broker.revalidateWorkerIdentities();
    assert.equal(ws.closeCode, scenario.closeCode, scenario.name);
    assert.equal(ws.closeReason, scenario.closeReason, scenario.name);
    assert.equal(
      broker.isOnline(identity.id),
      scenario.state === 'active' || scenario.state === 'capability-added',
      scenario.name,
    );
    if (scenario.state === 'capability-added') {
      assert.deepEqual(ws.authorizedCapabilities, ['workspace.exec'], 'new grants need reconnect');
    }
    broker.close();
  }
});

void test('fresh dispatch and stream reject sessions whose persisted identity or grants changed', async () => {
  const original = fixtureWorker({
    id: 'fixture-stale-session',
    owner_user_id: 'owner-a',
    public_key: 'test-key-a',
    enabled: true,
    capabilities: ['workspace.exec', 'shell.attach'],
  });
  for (const { label, current, reason } of [
    {
      label: 'owner-reassigned',
      current: { ...original, owner_user_id: 'owner-b' },
      reason: 'worker-identity-changed',
    },
    {
      label: 'public-key-rotated',
      current: { ...original, public_key: 'test-key-b' },
      reason: 'worker-identity-changed',
    },
    {
      label: 'capability-revoked',
      current: { ...original, capabilities: ['workspace.exec'] },
      reason: 'worker-capability-revoked',
    },
  ]) {
    for (const operation of ['dispatch', 'stream'] as const) {
      const broker = createBroker({
        repository: { findWorkerById: () => Promise.resolve(current) },
      });
      const sent: string[] = [];
      const ws = socketDouble({
        workerId: original.id,
        worker: original,
        readyState: Number(WebSocket.OPEN),
        closeCode: 0,
        closeReason: '',
        on() {},
        send(raw: string) {
          if ((JSON.parse(raw) as { type?: string }).type !== 'connected') sent.push(raw);
        },
        close(code: number, text: string) {
          this.closeCode = code;
          this.closeReason = text;
          this.readyState = WebSocket.CLOSED;
        },
      });
      broker.handleConnection(ws, requestDouble(original));
      await assert.rejects(
        operation === 'dispatch'
          ? broker.dispatch(original.id, 'workspace.exec', {})
          : broker.openStream(original.id, 'shell.attach', {}),
        (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === 'WORKER_SESSION_REVOKED',
        `${label} ${operation}`,
      );
      assert.equal(ws.closeCode, 4003, `${label} ${operation}`);
      assert.equal(ws.closeReason, reason, `${label} ${operation}`);
      assert.equal(broker.isOnline(original.id), false);
      assert.deepEqual(sent, [], 'stale credentials cannot send jobs or streams');
      broker.close();
    }
  }
});

void test('dispatch and stream immediately revoke disabled, removed or unverifiable Worker identity', async () => {
  const initial = fixtureWorker({
    id: 'fixture-revoked-on-dispatch',
    enabled: true,
    capabilities: ['workspace.exec', 'shell.attach'],
  });
  for (const scenario of [
    {
      name: 'disabled',
      state: 'disabled',
      code: 'WORKER_DISABLED',
      closeCode: 4003,
      reason: 'worker-disabled',
    },
    {
      name: 'removed',
      state: 'removed',
      code: 'WORKER_NOT_FOUND',
      closeCode: 4004,
      reason: 'worker-removed',
    },
    {
      name: 'database unavailable',
      state: 'unavailable',
      code: 'WORKER_STATUS_UNAVAILABLE',
      closeCode: 4003,
      reason: 'worker-status-unavailable',
    },
  ] as const) {
    for (const operation of ['dispatch', 'stream'] as const) {
      const broker = createBroker({
        repository: {
          findWorkerById: () =>
            scenario.state === 'unavailable'
              ? Promise.reject(new Error('fixture unavailable'))
              : Promise.resolve(
                  scenario.state === 'removed' ? null : { ...initial, enabled: false },
                ),
        },
      });
      const sent: string[] = [];
      const ws = socketDouble({
        workerId: initial.id,
        worker: initial,
        readyState: Number(WebSocket.OPEN),
        closeCode: 0,
        closeReason: '',
        on() {},
        send(raw: string) {
          const message = JSON.parse(raw) as { type?: string };
          if (message.type !== 'connected') sent.push(raw);
        },
        close(code: number, reason: string) {
          this.closeCode = code;
          this.closeReason = reason;
          this.readyState = WebSocket.CLOSED;
        },
      });
      broker.handleConnection(ws, requestDouble(initial));
      await assert.rejects(
        operation === 'dispatch'
          ? broker.dispatch(initial.id, 'workspace.exec', {})
          : broker.openStream(initial.id, 'shell.attach', {}),
        (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === scenario.code,
        `${scenario.name}: ${operation}`,
      );
      assert.equal(ws.closeCode, scenario.closeCode);
      assert.equal(ws.closeReason, scenario.reason);
      assert.equal(broker.isOnline(initial.id), false);
      assert.deepEqual(sent, [], 'no request can reach an unauthorized Worker');
      broker.close();
    }
  }
});

void test('late Worker identity lookup failure does not revoke a replacement socket', async () => {
  const worker = fixtureWorker({
    id: 'fixture-replaced-during-identity-read',
    enabled: true,
    capabilities: ['workspace.exec'],
  });
  let rejectLookup: ((reason: Error) => void) | undefined;
  const broker = createBroker({
    repository: {
      findWorkerById: () =>
        new Promise<WorkerRow | null>((_resolve, reject) => {
          rejectLookup = reject;
        }),
    },
  });
  const makeSocket = () =>
    socketDouble({
      workerId: worker.id,
      worker,
      readyState: Number(WebSocket.OPEN),
      closeCode: 0,
      on() {},
      send() {},
      close(code: number) {
        this.closeCode = code;
        this.readyState = WebSocket.CLOSED;
      },
    });
  const first = makeSocket();
  broker.handleConnection(first, requestDouble(worker));
  const pending = broker.dispatch(worker.id, 'workspace.exec', {});
  assert.ok(rejectLookup);
  const second = makeSocket();
  broker.handleConnection(second, requestDouble(worker));
  rejectLookup(new Error('fixture database disconnected'));
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_STATUS_UNAVAILABLE',
  );
  assert.equal(second.closeCode, 0, 'late error must not close new authenticated session');
  assert.equal(broker.isOnline(worker.id), true);
  broker.close();
});

void test('delayed external identity check cannot close a replacement Worker socket', async () => {
  const worker = fixtureWorker({
    id: 'fixture-identity-socket-race',
    enabled: true,
    capabilities: ['workspace.exec'],
  });
  let releaseLookup: ((value: WorkerRow | null) => void) | undefined;
  const broker = createBroker({
    repository: {
      findWorkerById: () =>
        new Promise<WorkerRow | null>((resolve) => {
          releaseLookup = resolve;
        }),
    },
  });
  const makeSocket = () =>
    socketDouble({
      workerId: worker.id,
      worker,
      readyState: Number(WebSocket.OPEN),
      closeCode: 0,
      on() {},
      send() {},
      close(code: number) {
        this.closeCode = code;
        this.readyState = WebSocket.CLOSED;
      },
    });
  const oldSocket = makeSocket();
  broker.handleConnection(oldSocket, requestDouble(worker));
  const checking = broker.revalidateWorkerIdentities();
  assert.ok(releaseLookup);
  const currentSocket = makeSocket();
  broker.handleConnection(currentSocket, requestDouble(worker));
  releaseLookup(null);
  await checking;
  assert.equal(
    currentSocket.closeCode,
    0,
    'late status from old socket must not revoke new socket',
  );
  assert.equal(broker.isOnline(worker.id), true);
  broker.close();
});

void test('Worker and app scalar parsing reject hostile toString and bound circular arrays', () => {
  const hostile = {
    toString: () => {
      throw new Error('Hostile object toString called');
    },
  };
  const recursive: unknown[] = [];
  recursive.push(recursive);
  for (const convert of [appStringifyUnknown, lifecycle.stringifyUnknown]) {
    assert.equal(convert(hostile), '[object Object]');
    assert.equal(convert(recursive), '');
    assert.equal(convert(['alpha', 1, null, false]), 'alpha,1,,false');
  }
});
