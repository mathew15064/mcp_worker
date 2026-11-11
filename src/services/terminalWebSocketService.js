const http = require('http');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer, WebSocket } = require('ws');
const sessionMiddleware = require('../middleware/sessionMiddleware');
const authService = require('./authService');
const workerRepository = require('../repositories/workerRepository');
const workerBroker = require('./workerConnectionBroker');
const terminalNonceService = require('./terminalNonceService');
const { canonicalOrigin } = require('./terminalPublicOriginService');

function rejectUpgrade(socket, status = 401, code = 'WEBSOCKET_HANDSHAKE_FAILED') {
  const reason = http.STATUS_CODES[status] || 'Rejected';
  try {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n${JSON.stringify({ code })}`);
  } catch (_) {
    try { socket.destroy(); } catch (_) {}
  }
}

function parseSession(request, parser) {
  return new Promise((resolve, reject) => {
    const response = new http.ServerResponse(request);
    parser(request, response, error => error ? reject(error) : resolve());
  });
}

function safeSend(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

async function profileForIdentity(repository, identity, profileId) {
  if (identity?.role === 'admin') return repository.findAdminProfileById(profileId);
  if (identity?.role === 'user') return repository.findProfileByIdForOwner(profileId, identity.id);
  return null;
}

function attachTerminalWebSocket(server, overrides = {}) {
  const deps = {
    sessionMiddleware,
    authService,
    workerRepository,
    workerBroker,
    nonceService: terminalNonceService,
    idleTimeoutMs: 60 * 60 * 1000,
    maxSessionMs: 8 * 60 * 60 * 1000,
    ...overrides
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 70 * 1024 });
  const activeBySession = new Map();
  const maxTabsPerSession = 20;
  const maxConnections = 32;

  server.on('upgrade', async (request, socket, head) => {
    try {
      const url = new URL(request.url, 'http://terminal.invalid');
      if (url.pathname !== '/terminal/ws') return;
      const claimed = deps.nonceService.claim(url.searchParams.get('attempt_id'), url.searchParams.get('nonce'));
      const record = claimed.record;
      if (claimed.code) return rejectUpgrade(socket, 401, claimed.code);

      await parseSession(request, deps.sessionMiddleware);
      const identity = await deps.authService.currentIdentity(request.session);
      const sessionVersion = Number(request.session?.sessionVersion || 1);
      if (!identity || !request.sessionID) return rejectUpgrade(socket, 401, 'SESSION_MISSING');
      if (record.userId !== identity.id || record.sessionVersion !== sessionVersion || !deps.nonceService.matchesSession(record, request.sessionID)) {
        return rejectUpgrade(socket, 401, 'SESSION_MISMATCH');
      }
      const requestOrigin = canonicalOrigin(request.headers.origin);
      if (!requestOrigin || requestOrigin !== record.origin) return rejectUpgrade(socket, 403, 'ORIGIN_REJECTED');

      const profile = await profileForIdentity(deps.workerRepository, identity, record.profileId);
      if (!profile) return rejectUpgrade(socket, 404, 'PROFILE_NOT_FOUND');
      if (!profile.enabled) return rejectUpgrade(socket, 409, 'PROFILE_DISABLED');
      if (!deps.workerBroker.isOnline(profile.worker_id)) return rejectUpgrade(socket, 503, 'WORKER_OFFLINE');

      const sessionKey = `${identity.id}:${record.sessionHash}`;
      if ((activeBySession.get(sessionKey) || 0) >= maxTabsPerSession) return rejectUpgrade(socket, 429, 'TAB_LIMIT_REACHED');
      if (wss.clients.size >= maxConnections) return rejectUpgrade(socket, 503, 'GLOBAL_CONNECTION_LIMIT');

      request.terminalAuth = { identity, sessionVersion, sessionKey, profile };
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    } catch (_) {
      rejectUpgrade(socket, 503, 'WEBSOCKET_HANDSHAKE_FAILED');
    }
  });

  wss.on('connection', (ws, request) => {
    const { identity, sessionVersion, sessionKey, profile } = request.terminalAuth;
    activeBySession.set(sessionKey, (activeBySession.get(sessionKey) || 0) + 1);
    const decoder = new StringDecoder('utf8');
    let workerStream = null;
    let cleaned = false;
    let cols = 80;
    let rows = 24;
    let frames = 0;
    let frameWindow = Date.now();

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { workerStream?.close(); } catch (_) {}
      const remaining = Math.max(0, (activeBySession.get(sessionKey) || 1) - 1);
      if (remaining) activeBySession.set(sessionKey, remaining);
      else activeBySession.delete(sessionKey);
    };

    const revalidate = () => new Promise(resolve => {
      const finish = async error => {
        if (error) return resolve(false);
        try {
          const current = await deps.authService.currentIdentity(request.session);
          if (!current || current.id !== identity.id || current.role !== identity.role || Number(request.session?.sessionVersion || 1) !== sessionVersion) return resolve(false);
          const currentProfile = await profileForIdentity(deps.workerRepository, current, profile.id);
          resolve(Boolean(currentProfile?.enabled && currentProfile.worker_id === profile.worker_id && deps.workerBroker.isOnline(profile.worker_id)));
        } catch (_) { resolve(false); }
      };
      if (request.session?.reload) request.session.reload(finish);
      else finish();
    });
    ws.revalidate = revalidate;
    safeSend(ws, { type: 'state', state: 'CONNECTING' });

    Promise.resolve().then(async () => {
      try {
        if (!await revalidate()) throw Object.assign(new Error('Session expired.'), { code: 'SESSION_REJECTED' });
        workerStream = await deps.workerBroker.openStream(profile.worker_id, 'shell.attach', {
          session_key: `profile:${profile.id}`,
          cols,
          rows
        }, {
          onState: state => safeSend(ws, { type: 'state', state }),
          onOutput: chunk => {
            ws.lastActivityAt = Date.now();
            const output = decoder.write(chunk);
            if (output) safeSend(ws, { type: 'output', data: output });
          },
          onError: error => {
            safeSend(ws, { type: 'error', code: error.code || 'SHELL_ATTACH_FAILED', message: error.message || 'Shell attach failed.' });
            cleanup();
            try { ws.close(); } catch (_) {}
          },
          onClose: () => {
            const output = decoder.end();
            if (output) safeSend(ws, { type: 'output', data: output });
            safeSend(ws, { type: 'state', state: 'CLOSED' });
            cleanup();
            try { ws.close(); } catch (_) {}
          }
        });
      } catch (error) {
        safeSend(ws, { type: 'error', code: error.code || 'SHELL_ATTACH_FAILED', message: error.message || 'Unable to attach shell.' });
        cleanup();
        try { ws.close(); } catch (_) {}
      }
    });

    ws.isAlive = true;
    ws.startedAt = Date.now();
    ws.lastActivityAt = ws.startedAt;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async raw => {
      ws.lastActivityAt = Date.now();
      if (cleaned) return;
      let message;
      try { message = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;

      const now = Date.now();
      if (now - frameWindow >= 1000) { frameWindow = now; frames = 0; }
      if (++frames > 512) { cleanup(); return ws.close(1008); }
      if (!await revalidate()) { cleanup(); return ws.close(1008); }

      if (message.type === 'input' && workerStream && typeof message.data === 'string' && Buffer.byteLength(message.data, 'utf8') <= 64 * 1024) {
        try { workerStream.input(message.data); } catch (_) { cleanup(); ws.close(); }
        return;
      }
      if (message.type === 'resize') {
        const nextCols = Number(message.cols);
        const nextRows = Number(message.rows);
        if (!Number.isInteger(nextCols) || !Number.isInteger(nextRows) || nextCols < 2 || nextCols > 500 || nextRows < 2 || nextRows > 200) return;
        cols = nextCols;
        rows = nextRows;
        try { workerStream?.resize(cols, rows); } catch (_) {}
        return;
      }
      if (message.type === 'close') ws.close();
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  const heartbeat = setInterval(async () => {
    for (const ws of wss.clients) {
      const now = Date.now();
      if (now - ws.startedAt > deps.maxSessionMs || now - ws.lastActivityAt > deps.idleTimeoutMs || ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      if (typeof ws.revalidate === 'function' && !await ws.revalidate()) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  return {
    wss,
    activeCount: () => [...activeBySession.values()].reduce((sum, value) => sum + value, 0),
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    }
  };
}

module.exports = { attachTerminalWebSocket, rejectUpgrade, parseSession, profileForIdentity };
