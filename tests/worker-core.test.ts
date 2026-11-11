import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const { WorkerAuthService, canonicalConnectMessage } = require('../src/services/workerAuthService');
const { WorkerConnectionBroker } = require('../src/services/workerConnectionBroker');
const { WorkerExecutionService } = require('../src/services/workerExecutionService');
const { TerminalMcpService } = require('../src/services/terminalMcpService');
import lifecycle from '../worker/lifecycle';
const { buildCleanupPlan, applyCleanupPlan } = lifecycle;

void test('worker enrollment normalizes capabilities and signed handshake rejects replay', async () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let storedWorker: {
    id: string;
    name: string;
    public_key: string;
    capabilities: string[];
    enabled: boolean;
  } | null = null;
  let consumed = false;
  const repository = {
    async consumeEnrollmentToken(token: string) {
      assert.equal(token, 'br_enroll_fixture');
      if (consumed)
        throw Object.assign(new Error('used'), { code: 'WORKER_ENROLLMENT_INVALID', status: 401 });
      consumed = true;
    },
    async createWorker({
      name,
      publicKey: normalized,
      capabilities,
    }: {
      name: string;
      publicKey: string;
      capabilities: string[];
    }) {
      storedWorker = {
        id: crypto.randomUUID(),
        name,
        public_key: normalized,
        capabilities,
        enabled: true,
      };
      return storedWorker;
    },
    async findWorkerById(id: string) {
      return storedWorker?.id === id ? storedWorker : null;
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

void test('worker broker dispatch correlates typed result and fails closed on missing capability', async () => {
  const workerId = crypto.randomUUID();
  const workerRecord = { id: workerId, capabilities: ['workspace.exec'], enabled: true };
  const broker = new WorkerConnectionBroker({
    repository: { findWorkerById: async (id: string) => (id === workerId ? workerRecord : null) },
    defaultTimeoutMs: 1000,
  });
  const dispatched: { value: { type: string; operation: string; job_id: string } | null } = {
    value: null,
  };
  const ws = {
    workerId,
    worker: { id: workerId, capabilities: ['workspace.exec'] },
    readyState: WebSocket.OPEN,
    send(text: string) {
      dispatched.value = JSON.parse(text);
    },
  };
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

void test('worker heartbeat skips redundant capabilities writes but preserves presence updates', async () => {
  const workerId = crypto.randomUUID();
  const writes: Array<{ id: string; capabilities: string[] }> = [];
  let presenceTouches = 0;
  const broker = new WorkerConnectionBroker({
    repository: {
      async updateWorkerCapabilities(id: string, capabilities: string[]) {
        writes.push({ id, capabilities });
      },
      async touchWorker(id: string) {
        assert.equal(id, workerId);
        presenceTouches += 1;
      },
    },
  });
  const ws = {
    workerId,
    worker: { id: workerId, capabilities: ['workspace.exec'] },
    readyState: WebSocket.OPEN,
    send() {},
    close() {},
  };
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
  assert.deepEqual(writes, [{ id: workerId, capabilities: ['file.write', 'workspace.exec'] }]);
  broker.close();
});

void test('late close and result from a replaced Worker socket cannot affect the current connection', async () => {
  const workerId = crypto.randomUUID();
  const worker = { id: workerId, enabled: true, capabilities: ['workspace.exec'] };
  const presence: string[] = [];
  const broker = new WorkerConnectionBroker({
    repository: {
      async findWorkerById() {
        return worker;
      },
      async updateWorkerPresence(_id: string, status: string) {
        presence.push(status);
      },
    },
    defaultTimeoutMs: 1_000,
  });
  const socket = () => {
    const listeners: Record<string, (() => void) | undefined> = {};
    return {
      workerId,
      worker: { ...worker },
      readyState: WebSocket.OPEN as number,
      sent: [] as Array<{ type: string; job_id: string }>,
      on(name: string, callback: () => void) {
        listeners[name] = callback;
      },
      send(text: string) {
        this.sent.push(JSON.parse(text));
      },
      close() {
        this.readyState = WebSocket.CLOSED;
        listeners.close?.();
      },
      triggerClose() {
        listeners.close?.();
      },
    };
  };
  const first = socket();
  broker.handleConnection(first, { workerAuth: { worker } });
  const abandoned = broker.dispatch(workerId, 'workspace.exec', {}, { timeoutMs: 1_000 });
  await new Promise((resolve) => setImmediate(resolve));
  const firstJob = first.sent.find((message) => message.type === 'job');
  assert.ok(firstJob);

  const second = socket();
  broker.handleConnection(second, { workerAuth: { worker } });
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

void test('Worker broker limits regular jobs but reserves slots for lifecycle control', async () => {
  const workerId = crypto.randomUUID();
  const worker = { id: workerId, capabilities: ['workspace.exec'], enabled: true };
  const broker = new WorkerConnectionBroker({
    repository: { findWorkerById: async () => worker },
    maxPendingGlobal: 1,
    maxPendingPerWorker: 1,
    maxControlGlobal: 1,
    maxControlPerWorker: 1,
    maxBufferedBytes: 32,
  });
  const sent: Array<{ type: string; job_id: string }> = [];
  const ws = {
    workerId,
    worker,
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(raw: string) {
      sent.push(JSON.parse(raw));
    },
    close() {},
  };
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
  const worker = { id: workerId, capabilities: ['shell.attach'], enabled: true };
  const broker = new WorkerConnectionBroker({
    repository: { findWorkerById: async () => worker },
    maxStreamsGlobal: 1,
    maxStreamsPerWorker: 1,
    maxBufferedBytes: 32,
  });
  const ws = {
    workerId,
    worker,
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send() {},
    close() {},
  };
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
    workerId: string;
    workerName: string;
    memoryUsedPercent: number;
    phase: string;
    stopped: Record<string, number>;
  }> = [];
  const broker = new WorkerConnectionBroker({
    repository: { findWorkerById: async () => null },
    notifier: {
      async sendWorkerResourceAlert(alert: {
        workerId: string;
        workerName: string;
        memoryUsedPercent: number;
        phase: string;
        stopped: Record<string, number>;
      }) {
        alerts.push(alert);
        return { sent: true };
      },
    },
  });
  const ws = {
    workerId,
    worker: { id: workerId, name: 'VPS Worker', capabilities: [], enabled: true },
    readyState: WebSocket.OPEN,
  };
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
    async dispatch(
      workerId: string,
      operation: string,
      payload: Record<string, unknown>,
      options: unknown,
    ) {
      calls.push({ workerId, operation, payload, options });
      if (operation === 'shell.inspect')
        return { pane_count: 1, target_pane: 'shell', pane_current_command: 'bash' };
      if (operation === 'workspace.exec')
        return {
          exit_code: 0,
          stdout: 'ok',
          stderr: '',
          duration_ms: 1,
          stdout_truncated: false,
          stderr_truncated: false,
        };
      return { code: 'OK' };
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
    transport: 'worker',
  };
  const worker = {
    async inspectProfile() {
      return {
        pane_count: 1,
        target_pane: '%1',
        pane_current_command: 'bash',
        panes: [{ id: '%1', current_command: 'bash' }],
      };
    },
    async execWorkspaceCommand(_profile: unknown, password: string | null, command: string) {
      assert.equal(password, null);
      assert.equal(command, 'printf ok');
      return {
        exit_code: 0,
        stdout: 'ok',
        stderr: '',
        duration_ms: 2,
        stdout_truncated: false,
        stderr_truncated: false,
      };
    },
  };
  const service = new TerminalMcpService({
    profiles: {
      findAll: async () => [profile],
      findWithCredentialById: async () => {
        throw new Error('must not read SSH credential');
      },
    },
    credentials: {
      decrypt: () => {
        throw new Error('must not decrypt SSH credential');
      },
    },
    ssh: {
      inspectProfile: async () => {
        throw new Error('must not use SSH');
      },
    },
    worker,
    audit: { log: async () => {} },
  });
  const status = await service.status('Worker Dev');
  assert.equal(status.status, 'READY');
  const result = await service.workspaceExec('Worker Dev', 'printf ok', { cwd: '/work' });
  assert.equal(result.stdout, 'ok');
});

void test('dispatch rejects a socket replaced during asynchronous Worker lookup', async () => {
  const workerId = crypto.randomUUID();
  const worker = { id: workerId, enabled: true, capabilities: ['workspace.exec'] };
  let completeLookup: (value: unknown) => void = () => {};
  const broker = new WorkerConnectionBroker({
    repository: {
      findWorkerById: () =>
        new Promise((resolve) => {
          completeLookup = resolve;
        }),
    },
    defaultTimeoutMs: 100,
  });
  let sent = 0;
  const first = {
    workerId,
    worker,
    readyState: WebSocket.OPEN,
    send() {
      sent++;
    },
    close() {},
  };
  const second = { workerId, worker, readyState: WebSocket.OPEN, send() {}, close() {} };
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
  const worker = { id: workerId, enabled: true, capabilities: ['shell.attach'] };
  let finish: (value: unknown) => void = () => {};
  const broker = new WorkerConnectionBroker({
    repository: {
      findWorkerById: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  let sent = 0;
  const first = {
    workerId,
    worker,
    readyState: WebSocket.OPEN,
    send() {
      sent++;
    },
    close() {},
  };
  const second = { ...first };
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
