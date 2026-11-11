const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const workerAuthService = require('./workerAuthService');
const workerRepository = require('../repositories/workerRepository');
const { WORKER_CONNECT_PATH } = require('./workerAuthService');
const ownerNotificationService = require('./ownerNotificationService');

function brokerError(code, message, status = 503) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function rejectUpgrade(socket, status, code) {
  if (!socket || socket.destroyed) return;
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 429 ? 'Too Many Requests' : 'Service Unavailable';
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ code })}`);
  } catch (_) {}
  try { socket.destroy(); } catch (_) {}
}

class WorkerConnectionBroker {
  constructor({
    authService = workerAuthService, repository = workerRepository, notifier = ownerNotificationService,
    defaultTimeoutMs = 30_000, maxPendingGlobal = 256, maxPendingPerWorker = 16,
    maxControlGlobal = 16, maxControlPerWorker = 4, maxStreamsGlobal = 128,
    maxStreamsPerWorker = 16, maxBufferedBytes = 8 * 1024 * 1024
  } = {}) {
    this.authService = authService;
    this.repository = repository;
    this.notifier = notifier;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxPendingGlobal = maxPendingGlobal;
    this.maxPendingPerWorker = maxPendingPerWorker;
    this.maxControlGlobal = maxControlGlobal;
    this.maxControlPerWorker = maxControlPerWorker;
    this.maxStreamsGlobal = maxStreamsGlobal;
    this.maxStreamsPerWorker = maxStreamsPerWorker;
    this.maxBufferedBytes = maxBufferedBytes;
    this.connections = new Map();
    this.pending = new Map();
    this.streams = new Map();
    this.wss = null;
    this.server = null;
    this.upgradeHandler = null;
  }

  attach(server) {
    if (this.server) return this;
    this.server = server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    this.upgradeHandler = async (request, socket, head) => {
      let url;
      try { url = new URL(request.url, 'http://worker.invalid'); } catch (_) { return; }
      if (url.pathname !== WORKER_CONNECT_PATH) return;
      try {
        const worker = await this.authService.authenticateConnect(request.headers || {});
        request.workerAuth = { worker };
        this.wss.handleUpgrade(request, socket, head, ws => this.wss.emit('connection', ws, request));
      } catch (error) {
        const workerId = String(request.headers?.['x-br-worker-id'] || '').trim().slice(0, 64);
        console.warn(`[WORKER_AUTH] rejected worker=${workerId || 'unknown'} code=${error.code || 'WORKER_AUTH_INVALID'} status=${error.status || 401}`);
        rejectUpgrade(socket, error.status || 401, error.code || 'WORKER_AUTH_INVALID');
      }
    };
    server.on('upgrade', this.upgradeHandler);
    this.wss.on('connection', (ws, request) => this.handleConnection(ws, request));
    return this;
  }

  handleConnection(ws, request) {
    const worker = request.workerAuth.worker;
    const workerId = worker.id;
    const previous = this.connections.get(workerId);
    this.connections.set(workerId, ws);
    if (previous && previous !== ws) {
      try { previous.close(4001, 'replaced'); } catch (_) {}
      this.handleDisconnect(previous);
    }
    ws.workerId = workerId;
    ws.worker = worker;
    Promise.resolve(this.repository.updateWorkerPresence(workerId, 'online')).catch(() => {});

    try {
      ws.send(JSON.stringify({ type: 'connected', worker_id: workerId, server_time: new Date().toISOString() }));
    } catch (_) {}

    ws.on('message', data => this.handleMessage(ws, data));
    ws.on('close', () => this.handleDisconnect(ws));
    ws.on('error', () => this.handleDisconnect(ws));
  }

  handleMessage(ws, data) {
    let message;
    try {
      message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch (_) {
      try { ws.close(1003, 'invalid-json'); } catch (_) {}
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (ws.workerId && this.connections.has(ws.workerId) && this.connections.get(ws.workerId) !== ws) return;
    if (message.type === 'resource_alert') {
      const code = String(message.code || '');
      if (!['WORKER_MEMORY_EMERGENCY', 'WORKER_MEMORY_RECOVERED'].includes(code)) return;
      const stopped = message.stopped && typeof message.stopped === 'object' ? message.stopped : {};
      Promise.resolve(this.notifier.sendWorkerResourceAlert({
        code,
        severity: String(message.severity || ''),
        phase: String(message.phase || ''),
        workerId: ws.workerId,
        workerName: String(ws.worker?.name || message.worker_name || '').slice(0, 120),
        memoryUsedPercent: Number(message.memory_used_percent || 0),
        memoryTotalBytes: Number(message.memory_total_bytes || 0),
        memoryAvailableBytes: Number(message.memory_available_bytes || 0),
        thresholdPercent: Number(message.threshold_percent || 90),
        resumePercent: Number(message.resume_percent || 85),
        stopped: {
          workspace_commands: Math.max(0, Number(stopped.workspace_commands || 0)),
          managed_processes: Math.max(0, Number(stopped.managed_processes || 0)),
          shell_sessions: Math.max(0, Number(stopped.shell_sessions || 0))
        }
      })).catch(error => console.error('[WORKER_ALERT] Telegram delivery failed:', error.message));
      return;
    }
    if (message.type === 'heartbeat') {
      const capabilities = Array.isArray(message.capabilities) ? this.authService.normalizeCapabilities(message.capabilities) : null;
      const previous = this.authService.normalizeCapabilities(Array.isArray(ws.worker?.capabilities) ? ws.worker.capabilities : []);
      if (capabilities && (capabilities.length !== previous.length || capabilities.some((cap, i) => cap !== previous[i]))) {
        ws.worker.capabilities = capabilities;
        Promise.resolve(this.repository.updateWorkerCapabilities(ws.workerId, capabilities)).catch(() => {});
      }
      Promise.resolve(this.repository.touchWorker(ws.workerId)).catch(() => {});
      try { ws.send(JSON.stringify({ type: 'heartbeat_ack', server_time: new Date().toISOString() })); } catch (_) {}
      return;
    }
    if (typeof message.stream_id === 'string' && message.type?.startsWith('stream_')) {
      const stream = this.streams.get(message.stream_id);
      if (!stream || stream.workerId !== ws.workerId || stream.ws !== ws) return;
      if (message.type === 'stream_state') return stream.onState?.(String(message.state || 'UNKNOWN'), message);
      if (message.type === 'stream_output') {
        try { return stream.onOutput?.(Buffer.from(String(message.data || ''), 'base64')); } catch (_) { return; }
      }
      if (message.type === 'stream_error') {
        const error = brokerError(String(message.error?.code || 'WORKER_STREAM_FAILED'), String(message.error?.message || 'Worker shell stream failed.'), 422);
        stream.onError?.(error);
        this.streams.delete(message.stream_id);
        return;
      }
      if (message.type === 'stream_closed') {
        this.streams.delete(message.stream_id);
        return stream.onClose?.(message);
      }
      return;
    }
    if (message.type !== 'result' || typeof message.job_id !== 'string') return;
    const pending = this.pending.get(message.job_id);
    if (!pending || pending.workerId !== ws.workerId || pending.ws !== ws) return;
    this.pending.delete(message.job_id);
    clearTimeout(pending.timer);
    if (message.ok === true) return pending.resolve(message.result ?? null);
    const code = String(message.error?.code || 'WORKER_JOB_FAILED');
    const text = String(message.error?.message || 'Worker job failed.');
    return pending.reject(brokerError(code, text, 422));
  }

  handleDisconnect(ws) {
    if (!ws?.workerId) return;
    if (this.connections.get(ws.workerId) === ws) {
      this.connections.delete(ws.workerId);
      Promise.resolve(this.repository.updateWorkerPresence(ws.workerId, 'offline')).catch(() => {});
    }
    for (const [jobId, pending] of this.pending.entries()) {
      if (pending.workerId !== ws.workerId || pending.ws !== ws) continue;
      this.pending.delete(jobId);
      clearTimeout(pending.timer);
      pending.reject(brokerError('WORKER_DISCONNECTED', 'Worker disconnected while a job was running.'));
    }
    for (const [streamId, stream] of this.streams.entries()) {
      if (stream.workerId !== ws.workerId || stream.ws !== ws) continue;
      this.streams.delete(streamId);
      stream.onError?.(brokerError('WORKER_DISCONNECTED', 'Worker disconnected while a shell was attached.'));
      stream.onClose?.({ type: 'stream_closed', stream_id: streamId, reason: 'worker-disconnected' });
    }
  }

  isOnline(workerId) {
    const ws = this.connections.get(workerId);
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  // Ping the live outbound WebSocket. Offline Workers cannot receive commands.
  async probeConnection(workerId, { timeoutMs = 1500 } = {}) {
    const ws = this.connections.get(workerId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return { ok: false, reason: 'worker_offline' };
    const nonce = crypto.randomBytes(12);
    const started = Date.now();
    return new Promise(resolve => {
      let settled = false;
      let timer;
      const finish = (ok, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeListener('pong', onPong);
        ws.removeListener('close', onClose);
        ws.removeListener('error', onClose);
        resolve({ ok, reason: ok ? null : reason, latency_ms: ok ? Date.now() - started : null });
      };
      const onPong = payload => { if (Buffer.from(payload).equals(nonce)) finish(true, null); };
      const onClose = () => finish(false, 'worker_disconnected');
      ws.on('pong', onPong);
      ws.on('close', onClose);
      ws.on('error', onClose);
      timer = setTimeout(() => finish(false, 'probe_timeout'), Math.max(250, Math.min(Number(timeoutMs) || 1500, 3000)));
      try { ws.ping(nonce); } catch (_) { finish(false, 'probe_failed'); }
    });
  }

  disconnect(workerId, { code = 4003, reason = 'worker-disabled' } = {}) {
    const ws = this.connections.get(workerId);
    if (!ws) return false;
    try { ws.close(code, reason); } catch (_) {}
    this.handleDisconnect(ws);
    return true;
  }

  assertCapacity(workerId, ws, { control = false, stream = false } = {}) {
    if (Number(ws.bufferedAmount || 0) >= this.maxBufferedBytes) {
      throw brokerError('WORKER_BACKPRESSURE', 'Worker transport buffer is saturated.', 429);
    }
    const records = stream ? this.streams : this.pending;
    let globalCount = 0;
    let workerCount = 0;
    for (const record of records.values()) {
      if (!stream && Boolean(record.control) !== control) continue;
      globalCount += 1;
      if (record.workerId === workerId) workerCount += 1;
    }
    const globalLimit = stream ? this.maxStreamsGlobal : control ? this.maxControlGlobal : this.maxPendingGlobal;
    const workerLimit = stream ? this.maxStreamsPerWorker : control ? this.maxControlPerWorker : this.maxPendingPerWorker;
    if (globalCount >= globalLimit || workerCount >= workerLimit) {
      throw brokerError('WORKER_BUSY', 'Worker request capacity is exhausted.', 429);
    }
  }

  async dispatch(workerId, operation, payload = {}, { timeoutMs = null } = {}) {
    return this.dispatchInternal(workerId, operation, payload, { timeoutMs, enforceCapability: true });
  }

  async dispatchControl(workerId, operation, payload = {}, { timeoutMs = null } = {}) {
    if (operation !== 'worker.self_uninstall') {
      throw brokerError('WORKER_CONTROL_OPERATION_DENIED', `Unsupported worker control operation '${operation}'.`, 403);
    }
    return this.dispatchInternal(workerId, operation, payload, { timeoutMs, enforceCapability: false });
  }

  async dispatchInternal(workerId, operation, payload = {}, { timeoutMs = null, enforceCapability = true } = {}) {
    const ws = this.connections.get(workerId);
    if (!ws || ws.readyState !== WebSocket.OPEN) throw brokerError('WORKER_OFFLINE', 'Worker is not connected.');
    const worker = await this.repository.findWorkerById(workerId);
    // The lookup can yield while a Worker disconnects or reconnects.
    // Never send a new job or stream using a superseded socket.
    if (this.connections.get(workerId) !== ws || ws.readyState !== WebSocket.OPEN) {
      throw brokerError('WORKER_DISCONNECTED', 'Worker connection changed during request setup.');
    }
    if (!worker) throw brokerError('WORKER_NOT_FOUND', 'Worker not found.', 404);
    if (!worker.enabled) throw brokerError('WORKER_DISABLED', 'Worker identity is disabled.', 403);
    const capabilities = Array.isArray(ws.worker?.capabilities) ? ws.worker.capabilities : worker.capabilities;
    if (enforceCapability && !capabilities.includes(operation)) {
      throw brokerError('WORKER_CAPABILITY_DENIED', `Worker does not allow operation '${operation}'.`, 403);
    }
    this.assertCapacity(workerId, ws, { control: !enforceCapability });
    const requestedTimeout = Math.max(100, Math.min(Number(timeoutMs) || this.defaultTimeoutMs, 300_000));
    const jobId = `job_${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        reject(brokerError('WORKER_JOB_TIMEOUT', `Worker job '${operation}' timed out.`));
      }, requestedTimeout + 2_000);
      this.pending.set(jobId, { workerId, ws, resolve, reject, timer, operation, control: !enforceCapability });
      try {
        ws.send(JSON.stringify({
          type: 'job',
          job_id: jobId,
          operation,
          payload,
          timeout_ms: requestedTimeout
        }));
      } catch (_) {
        this.pending.delete(jobId);
        clearTimeout(timer);
        reject(brokerError('WORKER_DISCONNECTED', 'Unable to dispatch job to worker.'));
      }
    });
  }

  async openStream(workerId, operation, payload = {}, handlers = {}) {
    const ws = this.connections.get(workerId);
    if (!ws || ws.readyState !== WebSocket.OPEN) throw brokerError('WORKER_OFFLINE', 'Worker is not connected.');
    const worker = await this.repository.findWorkerById(workerId);
    // The lookup can yield while a Worker disconnects or reconnects.
    // Never send a new job or stream using a superseded socket.
    if (this.connections.get(workerId) !== ws || ws.readyState !== WebSocket.OPEN) {
      throw brokerError('WORKER_DISCONNECTED', 'Worker connection changed during request setup.');
    }
    if (!worker) throw brokerError('WORKER_NOT_FOUND', 'Worker not found.', 404);
    if (!worker.enabled) throw brokerError('WORKER_DISABLED', 'Worker identity is disabled.', 403);
    const capabilities = Array.isArray(ws.worker?.capabilities) ? ws.worker.capabilities : worker.capabilities;
    if (!capabilities.includes(operation)) throw brokerError('WORKER_CAPABILITY_DENIED', `Worker does not allow operation '${operation}'.`, 403);
    this.assertCapacity(workerId, ws, { stream: true });
    const streamId = `stream_${crypto.randomUUID()}`;
    const record = { workerId, ws, operation, ...handlers };
    this.streams.set(streamId, record);
    const send = message => {
      const current = this.connections.get(workerId);
      if (current !== ws || current.readyState !== WebSocket.OPEN) throw brokerError('WORKER_DISCONNECTED', 'Worker shell stream is disconnected.');
      if (message.type !== 'stream_close' && Number(current.bufferedAmount || 0) >= this.maxBufferedBytes) {
        throw brokerError('WORKER_BACKPRESSURE', 'Worker transport buffer is saturated.', 429);
      }
      current.send(JSON.stringify({ ...message, stream_id: streamId }));
    };
    try { send({ type: 'stream_open', operation, payload }); }
    catch (error) { this.streams.delete(streamId); throw error; }
    return {
      id: streamId,
      input(data) { send({ type: 'stream_input', data: Buffer.from(String(data), 'utf8').toString('base64') }); },
      resize(cols, rows) { send({ type: 'stream_resize', cols, rows }); },
      close: () => {
        if (!this.streams.has(streamId)) return;
        try { send({ type: 'stream_close' }); } catch (_) {}
        this.streams.delete(streamId);
      }
    };
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(brokerError('WORKER_BROKER_CLOSED', 'Worker broker is shutting down.'));
    }
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.onError?.(brokerError('WORKER_BROKER_CLOSED', 'Worker broker is shutting down.'));
      stream.onClose?.({ type: 'stream_closed', reason: 'broker-closed' });
    }
    this.streams.clear();
    for (const ws of this.connections.values()) {
      try { ws.close(1001, 'server-shutdown'); } catch (_) {}
    }
    this.connections.clear();
    if (this.server && this.upgradeHandler) this.server.removeListener('upgrade', this.upgradeHandler);
    try { this.wss?.close(); } catch (_) {}
    this.wss = null;
    this.server = null;
    this.upgradeHandler = null;
  }
}

module.exports = new WorkerConnectionBroker();
module.exports.WorkerConnectionBroker = WorkerConnectionBroker;
module.exports.brokerError = brokerError;
module.exports.rejectUpgrade = rejectUpgrade;
