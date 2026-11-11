import http, { type Server as HttpServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Request, Response, RequestHandler } from 'express';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import sessionMiddleware from '../middleware/sessionMiddleware';
import authService from './authService';
import workerRepository from '../repositories/workerRepository';
import workerBroker from './workerConnectionBroker';
import terminalNonceService from './terminalNonceService';
import terminalOrigins from './terminalPublicOriginService';
const { canonicalOrigin } = terminalOrigins;

function rejectUpgrade(socket: Duplex, status = 401, code = 'WEBSOCKET_HANDSHAKE_FAILED') {
  const reason = http.STATUS_CODES[status] || 'Rejected';
  try {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n\r\n${JSON.stringify({ code })}`,
    );
  } catch {
    try {
      socket.destroy();
    } catch {}
  }
}

function parseSession(request: TerminalRequest, parser: RequestHandler): Promise<void> {
  return new Promise((resolve, reject) => {
    const response = new http.ServerResponse(request);
    // express-session also accepts the underlying IncomingMessage/ServerResponse
    // at runtime; this is the sole HTTP-to-Express middleware adapter boundary.
    parser(request as unknown as Request, response as unknown as Response, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function safeSend(ws: TerminalSocket, message: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

type Identity = NonNullable<Awaited<ReturnType<typeof authService.currentIdentity>>>;
type WorkerProfile = NonNullable<Awaited<ReturnType<typeof workerRepository.findAdminProfileById>>>;
interface TerminalRequest extends IncomingMessage {
  session?: Request['session'];
  sessionID?: string;
  terminalAuth?: {
    identity: Identity;
    sessionVersion: number;
    sessionKey: string;
    profile: WorkerProfile;
  };
}
interface TerminalSocket extends WebSocket {
  revalidate?: () => Promise<boolean>;
  isAlive?: boolean;
  startedAt?: number;
  lastActivityAt?: number;
}
interface WorkerStream {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}
interface TerminalDeps {
  sessionMiddleware: RequestHandler;
  authService: Pick<typeof authService, 'currentIdentity'>;
  workerRepository: Pick<
    typeof workerRepository,
    'findAdminProfileById' | 'findProfileByIdForOwner'
  >;
  workerBroker: Pick<typeof workerBroker, 'isOnline' | 'openStream'>;
  nonceService: Pick<typeof terminalNonceService, 'claim' | 'matchesSession'>;
  idleTimeoutMs: number;
  maxSessionMs: number;
}
async function profileForIdentity(
  repository: TerminalDeps['workerRepository'],
  identity: Identity | null,
  profileId: string,
) {
  if (identity?.role === 'admin') return repository.findAdminProfileById(profileId);
  if (identity?.role === 'user') return repository.findProfileByIdForOwner(profileId, identity.id);
  return null;
}

function attachTerminalWebSocket(server: HttpServer, overrides: Partial<TerminalDeps> = {}) {
  const deps: TerminalDeps = {
    sessionMiddleware,
    authService,
    workerRepository,
    workerBroker,
    nonceService: terminalNonceService,
    idleTimeoutMs: 60 * 60 * 1000,
    maxSessionMs: 8 * 60 * 60 * 1000,
    ...overrides,
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 70 * 1024 });
  const activeBySession = new Map<string, number>();
  const maxTabsPerSession = 20;
  const maxConnections = 32;

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      const terminalRequest = request as TerminalRequest;
      const url = new URL(request.url || '', 'http://terminal.invalid');
      if (url.pathname !== '/terminal/ws') return;
      const claimed = deps.nonceService.claim(
        url.searchParams.get('attempt_id'),
        url.searchParams.get('nonce'),
      );
      const record = claimed.record;
      if (claimed.code || !record)
        return rejectUpgrade(socket, 401, claimed.code || 'NONCE_INVALID');

      await parseSession(terminalRequest, deps.sessionMiddleware);
      const identity = await deps.authService.currentIdentity(terminalRequest.session);
      const sessionVersion = Number(terminalRequest.session?.sessionVersion || 1);
      if (!identity || !terminalRequest.sessionID)
        return rejectUpgrade(socket, 401, 'SESSION_MISSING');
      if (
        record.userId !== identity.id ||
        record.sessionVersion !== sessionVersion ||
        !deps.nonceService.matchesSession(record, terminalRequest.sessionID)
      ) {
        return rejectUpgrade(socket, 401, 'SESSION_MISMATCH');
      }
      const requestOrigin = canonicalOrigin(request.headers.origin);
      if (!requestOrigin || requestOrigin !== record.origin)
        return rejectUpgrade(socket, 403, 'ORIGIN_REJECTED');

      const profile = await profileForIdentity(deps.workerRepository, identity, record.profileId);
      if (!profile) return rejectUpgrade(socket, 404, 'PROFILE_NOT_FOUND');
      if (!profile.enabled) return rejectUpgrade(socket, 409, 'PROFILE_DISABLED');
      if (!deps.workerBroker.isOnline(profile.worker_id))
        return rejectUpgrade(socket, 503, 'WORKER_OFFLINE');

      const sessionKey = `${identity.id}:${record.sessionHash}`;
      if ((activeBySession.get(sessionKey) || 0) >= maxTabsPerSession)
        return rejectUpgrade(socket, 429, 'TAB_LIMIT_REACHED');
      if (wss.clients.size >= maxConnections)
        return rejectUpgrade(socket, 503, 'GLOBAL_CONNECTION_LIMIT');

      terminalRequest.terminalAuth = { identity, sessionVersion, sessionKey, profile };
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    } catch {
      rejectUpgrade(socket, 503, 'WEBSOCKET_HANDSHAKE_FAILED');
    }
  }
  server.on('upgrade', (request, socket, head) => {
    void upgrade(request, socket, head).catch(() => rejectUpgrade(socket, 503));
  });

  wss.on('connection', (socket, request) => {
    const ws = socket as TerminalSocket;
    const terminalRequest = request as TerminalRequest;
    const authorization = terminalRequest.terminalAuth;
    if (!authorization) {
      ws.close(1008, 'missing-auth');
      return;
    }
    const { identity, sessionVersion, sessionKey, profile } = authorization;
    activeBySession.set(sessionKey, (activeBySession.get(sessionKey) || 0) + 1);
    const decoder = new StringDecoder('utf8');
    let workerStream: WorkerStream | null = null;
    let cleaned = false;
    let cols = 80;
    let rows = 24;
    let frames = 0;
    let frameWindow = Date.now();

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        workerStream?.close();
      } catch {}
      const remaining = Math.max(0, (activeBySession.get(sessionKey) || 1) - 1);
      if (remaining) activeBySession.set(sessionKey, remaining);
      else activeBySession.delete(sessionKey);
    };

    const revalidate = () =>
      new Promise<boolean>((resolve) => {
        const finish = async (error?: unknown) => {
          if (error) return resolve(false);
          try {
            const current = await deps.authService.currentIdentity(terminalRequest.session);
            if (
              !current ||
              current.id !== identity.id ||
              current.role !== identity.role ||
              Number(terminalRequest.session?.sessionVersion || 1) !== sessionVersion
            )
              return resolve(false);
            const currentProfile = await profileForIdentity(
              deps.workerRepository,
              current,
              profile.id,
            );
            resolve(
              Boolean(
                currentProfile?.enabled &&
                currentProfile.worker_id === profile.worker_id &&
                deps.workerBroker.isOnline(profile.worker_id),
              ),
            );
          } catch {
            resolve(false);
          }
        };
        const checked = (error?: unknown) => {
          void finish(error).catch(() => resolve(false));
        };
        if (terminalRequest.session?.reload) terminalRequest.session.reload(checked);
        else checked();
      });
    ws.revalidate = revalidate;
    safeSend(ws, { type: 'state', state: 'CONNECTING' });

    void Promise.resolve()
      .then(async () => {
        try {
          if (!(await revalidate()))
            throw Object.assign(new Error('Session expired.'), { code: 'SESSION_REJECTED' });
          workerStream = await deps.workerBroker.openStream(
            profile.worker_id,
            'shell.attach',
            {
              session_key: `profile:${profile.id}`,
              cols,
              rows,
            },
            {
              onState: (state) => safeSend(ws, { type: 'state', state }),
              onOutput: (chunk) => {
                ws.lastActivityAt = Date.now();
                const output = decoder.write(chunk);
                if (output) safeSend(ws, { type: 'output', data: output });
              },
              onError: (error) => {
                safeSend(ws, {
                  type: 'error',
                  code:
                    'code' in error ? error.code || 'SHELL_ATTACH_FAILED' : 'SHELL_ATTACH_FAILED',
                  message: error.message || 'Shell attach failed.',
                });
                cleanup();
                try {
                  ws.close();
                } catch {}
              },
              onClose: () => {
                const output = decoder.end();
                if (output) safeSend(ws, { type: 'output', data: output });
                safeSend(ws, { type: 'state', state: 'CLOSED' });
                cleanup();
                try {
                  ws.close();
                } catch {}
              },
            },
          );
        } catch (error) {
          const detail =
            error && typeof error === 'object'
              ? (error as { code?: string; message?: string })
              : {};
          safeSend(ws, {
            type: 'error',
            code: detail.code || 'SHELL_ATTACH_FAILED',
            message: detail.message || 'Unable to attach shell.',
          });
          cleanup();
          try {
            ws.close();
          } catch {}
        }
      })
      .catch(() => {
        cleanup();
        try {
          ws.terminate();
        } catch {}
      });

    ws.isAlive = true;
    ws.startedAt = Date.now();
    ws.lastActivityAt = ws.startedAt;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    async function handleFrame(raw: RawData) {
      ws.lastActivityAt = Date.now();
      if (cleaned) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return;
      const message = decoded as Record<string, unknown>;

      const now = Date.now();
      if (now - frameWindow >= 1000) {
        frameWindow = now;
        frames = 0;
      }
      if (++frames > 512) {
        cleanup();
        return ws.close(1008);
      }
      if (!(await revalidate())) {
        cleanup();
        return ws.close(1008);
      }

      if (
        message.type === 'input' &&
        workerStream &&
        typeof message.data === 'string' &&
        Buffer.byteLength(message.data, 'utf8') <= 64 * 1024
      ) {
        try {
          workerStream.input(message.data);
        } catch {
          cleanup();
          ws.close();
        }
        return;
      }
      if (message.type === 'resize') {
        const nextCols = Number(message.cols);
        const nextRows = Number(message.rows);
        if (
          !Number.isInteger(nextCols) ||
          !Number.isInteger(nextRows) ||
          nextCols < 2 ||
          nextCols > 500 ||
          nextRows < 2 ||
          nextRows > 200
        )
          return;
        cols = nextCols;
        rows = nextRows;
        try {
          workerStream?.resize(cols, rows);
        } catch {}
        return;
      }
      if (message.type === 'close') ws.close();
    }
    ws.on('message', (raw) => {
      void handleFrame(raw).catch(() => {
        cleanup();
        try {
          ws.terminate();
        } catch {}
      });
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  async function checkHeartbeat() {
    for (const peer of wss.clients) {
      const ws = peer as TerminalSocket;
      const now = Date.now();
      if (
        now - (ws.startedAt || now) > deps.maxSessionMs ||
        now - (ws.lastActivityAt || now) > deps.idleTimeoutMs ||
        ws.isAlive === false
      ) {
        ws.terminate();
        continue;
      }
      if (typeof ws.revalidate === 'function' && !(await ws.revalidate())) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
  const heartbeat = setInterval(() => {
    void checkHeartbeat().catch(() => {
      // Fail closed if revalidation or heartbeat transport unexpectedly fails.
      for (const peer of wss.clients) {
        try {
          peer.terminate();
        } catch {}
      }
    });
  }, 30_000);
  heartbeat.unref?.();

  return {
    wss,
    activeCount: () => [...activeBySession.values()].reduce((sum, value) => sum + value, 0),
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

export = { attachTerminalWebSocket, rejectUpgrade, parseSession, profileForIdentity };
