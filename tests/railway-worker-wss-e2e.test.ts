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
import type { Server as HttpsServer } from 'node:https';
import type { Server as HttpServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
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
    findWorkerById(id: string) {
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
  await waitUntil(() => heartbeatCount > 0 && record.capabilities.length === 1);
  await assert.rejects(
    () => broker.dispatch(workerId, 'workspace.exec', {}),
    codeIs('WORKER_CAPABILITY_DENIED'),
  );
  socket.send(
    JSON.stringify({
      type: 'heartbeat',
      capabilities: ['shell.inspect', 'workspace.exec'],
    }),
  );
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

/**
 * Full E2E is opt-in outside CI because it spawns a real local Worker.
 * Reproduce on a disposable Linux VM/container with Go >= 1.24:
 *   BOT_REPORT_T04_GO_E2E=1 npm test
 * It never accesses an external Railway project or an installed Worker.
 */
void test('fresh Railway SQLite owner and OAuth S256 drive a sandbox-built Go Worker over WSS', async (t) => {
  if (process.env.CI !== 'true' && process.env.BOT_REPORT_T04_GO_E2E !== '1') {
    t.skip('Real Go Worker requires an explicit disposable sandbox (or GitHub Actions CI)');
    return;
  }
  if (spawnSync('go', ['version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('Go toolchain is absent: real Worker acceptance must be run on a Go-equipped sandbox');
    return;
  }
  if (spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('OpenSSL is absent: cannot establish trusted test WSS');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't04-railway-go-'));
  const volume = path.join(root, 'volume');
  const workspace = path.join(root, 'workspace');
  const workerHome = path.join(root, 'go-worker-identity');
  fs.mkdirSync(volume, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(workerHome, { recursive: true, mode: 0o700 });
  const saved = new Map<string, string | undefined>();
  const vars: Record<string, string> = {
    MCP_PLATFORM: 'railway',
    MCP_SETUP_SECRET: crypto.randomBytes(32).toString('base64url'),
    RAILWAY_VOLUME_MOUNT_PATH: volume,
    RAILWAY_PUBLIC_DOMAIN: 'private-t04.up.railway.app',
    DATABASE_PATH: path.join(volume, 'worker.sqlite'),
    TRUST_PROXY: '1',
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    MCP_ENABLED: 'true',
  };
  for (const key of [...Object.keys(vars), 'MCP_PUBLIC_BASE_URL']) saved.set(key, process.env[key]);
  Object.assign(process.env, vars);
  delete process.env.MCP_PUBLIC_BASE_URL;

  let httpServer: HttpServer | null = null;
  let tlsServer: HttpsServer | null = null;
  let child: ChildProcess | null = null;
  const tls = certificate(root);
  const broker = (await import('../src/services/workerConnectionBroker.js')).default;
  const manager = (await import('../src/db/databaseManager.js')).default;
  const connection = await import('../src/db/connection.js');
  const terminate = async () => {
    if (child && child.exitCode === null && !child.killed) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
    }
    child = null;
  };
  t.after(async () => {
    try {
      await terminate();
    } catch {}
    broker.close();
    if (tlsServer) await new Promise<void>((resolve) => tlsServer?.close(() => resolve()));
    if (httpServer) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    try {
      await manager.close();
    } catch {}
    try {
      connection.closeDb();
    } catch {}
    manager.resetForTests();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  await manager.initialize();
  assert.equal(manager.isRailwaySqliteReady(), true);
  assert.equal(manager.status().engine, 'sqlite');
  const settings = (await import('../src/services/runtimeSettingsService.js')).default;
  await settings.seedDefaults(manager.getAdapter());
  const oauthConfig = (await import('../src/config/mcpConfig.js')).default;
  assert.equal(oauthConfig.issuer, 'https://private-t04.up.railway.app');
  const app = (await import('../src/app.js')).default;
  httpServer = (await import('node:http')).createServer(app);
  tlsServer = https.createServer({ key: tls.key, cert: tls.cert }, app);
  broker.attach(tlsServer);
  await new Promise<void>((resolve) => httpServer?.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => tlsServer?.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + String((httpServer.address() as AddressInfo).port);
  const secure = 'https://127.0.0.1:' + String((tlsServer.address() as AddressInfo).port);
  const forwarded = { 'x-forwarded-proto': 'https' };
  const getCookie = (res: Response) => (res.headers.get('set-cookie') || '').split(';')[0];
  const csrf = (html: string) => html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
  const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

  const first = await fetch(base + '/setup', { headers: forwarded });
  assert.equal(first.status, 200);
  const setupCookie = getCookie(first);
  const setupCsrf = csrf(await first.text());
  assert.ok(setupCookie && setupCsrf);
  const setup = await fetch(base + '/setup', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...forwarded,
      cookie: setupCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form({
      _csrf: setupCsrf,
      setup_key: vars.MCP_SETUP_SECRET,
      password: 'T04LocalAdminPassword2026!',
      confirm_password: 'T04LocalAdminPassword2026!',
    }),
  });
  assert.equal(setup.status, 303);
  const installer = await fetch(base + '/worker/install.sh', { headers: forwarded });
  assert.equal(installer.status, 503, 'Unsigned Railway installer must remain blocked');
  assert.equal(
    ((await installer.json()) as { code: string }).code,
    'WORKER_SIGNED_RELEASE_PENDING',
  );

  const login = await fetch(base + '/login', { headers: forwarded });
  assert.equal(login.status, 200);
  const loginCookie = getCookie(login);
  const loginCsrf = csrf(await login.text());
  const authenticated = await fetch(base + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...forwarded,
      cookie: loginCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form({
      _csrf: loginCsrf,
      username: 'admin',
      password: 'T04LocalAdminPassword2026!',
      returnTo: '/',
    }),
  });
  assert.equal(authenticated.status, 302);
  assert.ok(getCookie(authenticated));

  const workerRepo = (await import('../src/repositories/workerRepository.js')).default;
  const enrollment = await workerRepo.createEnrollmentToken();
  const executable = path.join(root, 't04-worker');
  const goEnv = {
    HOME: workerHome,
    BOT_REPORT_WORKER_HOME: workerHome,
    BOT_REPORT_WORKER_SKIP_SERVICE: '1',
    SSL_CERT_FILE: tls.certPath,
    PATH: process.env.PATH || '/usr/bin:/bin',
    GOTOOLCHAIN: 'auto',
    CGO_ENABLED: '0',
  };
  const built = spawnSync('go', ['build', '-trimpath', '-o', executable, '.'], {
    cwd: path.join(process.cwd(), 'worker-go'),
    env: goEnv,
    encoding: 'utf8',
    timeout: 240000,
  });
  assert.equal(
    built.status,
    0,
    'Sandbox Go build failed: ' + (built.stderr || built.error?.message || 'unknown'),
  );
  // Never use spawnSync for enrollment: the HTTPS server runs in this event loop.
  const enrolled = await new Promise<{ status: number; stderr: string }>((resolve, reject) => {
    const command = spawn(
      executable,
      [
        'login',
        '--server',
        secure,
        '--token',
        enrollment.token,
        '--roots',
        workspace,
        '--name',
        'T04-Worker',
        '--profile',
        'T04-Sandbox',
        '--allow-shell',
        '--no-start',
      ],
      { cwd: workspace, env: goEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 },
    );
    let stderr = '';
    command.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    command.once('error', reject);
    command.once('close', (code) => resolve({ status: code ?? 1, stderr }));
  });
  assert.equal(enrolled.status, 0, 'Ephemeral enrollment failed: ' + enrolled.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(workerHome, 'state.json'), 'utf8')) as {
    worker_id: string;
  };
  assert.ok(state.worker_id, 'Go Worker must generate a new local-only Ed25519 identity');
  const profile = await workerRepo.findProfileByName('T04-Sandbox');
  assert.ok(profile && profile.worker_id === state.worker_id);

  const spawnWorker = () => {
    child = spawn(executable, ['run'], { cwd: workspace, env: goEnv, stdio: 'ignore' });
    return child;
  };
  spawnWorker();
  await waitUntil(() => broker.isOnline(state.worker_id), 15000);
  assert.equal((await broker.probeConnection(state.worker_id)).ok, true);

  const oauth = (await import('../src/services/mcpOAuthService.js')).default;
  const registered = await oauth.registerClient({
    displayName: 'T04 Local Go MCP Client',
    principalId: 'principal:t04_railway_go',
    profileId: profile.id,
    redirectUris: ['http://localhost:40000/oauth/callback'],
    allowedScopes: ['bot_report.read', 'bot_report.terminal'],
  });
  const client = registered.client;
  assert.ok(client && registered.rawSecret);
  const verifier = crypto.randomBytes(48).toString('base64url');
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'http://localhost:40000/oauth/callback',
    response_type: 'code',
    scope: 'bot_report.read bot_report.terminal',
    state: 't04-local-pkce',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: oauthConfig.resourceUrl,
  });
  const consent = await fetch(base + '/oauth/authorize?' + params.toString(), {
    headers: { ...forwarded, cookie: getCookie(authenticated) },
    redirect: 'manual',
  });
  assert.equal(consent.status, 200);
  const consentParams = new URLSearchParams(params);
  consentParams.set('_csrf', csrf(await consent.text()));
  consentParams.set('action', 'allow');
  const approved = await fetch(base + '/oauth/authorize', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...forwarded,
      cookie: getCookie(authenticated),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: consentParams.toString(),
  });
  assert.equal(approved.status, 302);
  const redirected = new URL(approved.headers.get('location') || '');
  assert.equal(redirected.searchParams.get('state'), 't04-local-pkce');
  const code = redirected.searchParams.get('code');
  assert.ok(code);
  const grant = form({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'http://localhost:40000/oauth/callback',
    resource: oauthConfig.resourceUrl,
    code_verifier: verifier,
  });
  const tokenHeaders = {
    ...forwarded,
    'content-type': 'application/x-www-form-urlencoded',
    authorization:
      'Basic ' + Buffer.from(client.client_id + ':' + registered.rawSecret).toString('base64'),
  };
  const issued = await fetch(base + '/oauth/token', {
    method: 'POST',
    headers: tokenHeaders,
    body: grant,
  });
  assert.equal(issued.status, 200);
  const { access_token: token } = (await issued.json()) as { access_token: string };
  assert.match(token, /^br_at_/);
  assert.equal(
    (
      await fetch(base + '/oauth/token', {
        method: 'POST',
        headers: tokenHeaders,
        body: grant,
      })
    ).status,
    400,
    'PKCE authorization code must be single-use',
  );

  const request = (accessToken: string, id: number, name: string, command: string) =>
    fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        ...forwarded,
        authorization: 'Bearer ' + accessToken,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: { profile: 'T04-Sandbox', command, cwd: workspace } },
      }),
    });
  const invalid = await request('br_at_invalid_t04', 1, 'workspace_exec', 'true');
  assert.equal(invalid.status, 401);
  const call = await request(token, 2, 'workspace_exec', 'printf T04_GO_WORKER_OK');
  assert.equal(call.status, 200);
  const bodyText = await call.text();
  const event = bodyText
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .at(-1);
  const payload = JSON.parse(event ? event.slice(6) : bodyText) as {
    result?: { isError?: boolean; structuredContent?: { stdout?: string; exit_code?: number } };
  };
  assert.equal(payload.result?.isError, undefined, bodyText);
  assert.equal(payload.result?.structuredContent?.exit_code, 0, bodyText);
  assert.match(payload.result?.structuredContent?.stdout || '', /T04_GO_WORKER_OK/);

  const marker = path.join(workspace, 'non-idempotent-marker');
  const onceCommand = "printf 'once\\n' >> " + JSON.stringify(marker);
  const onceCall = await request(token, 3, 'workspace_exec', onceCommand);
  assert.equal(onceCall.status, 200);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');

  await terminate();
  await waitUntil(() => !broker.isOnline(state.worker_id), 5000);
  spawnWorker();
  await waitUntil(() => broker.isOnline(state.worker_id), 15000);
  assert.equal(
    fs.readFileSync(marker, 'utf8'),
    'once\n',
    'Reconnect must not replay a completed write',
  );

  // The identity remains server-side; the live socket's current capability set is authoritative.
  const active = broker.connections.get(state.worker_id);
  assert.ok(active?.worker);
  active.worker.capabilities = ['shell.inspect'];
  const deniedMarker = path.join(workspace, 'capability-denied-marker');
  const forbidden = await request(
    token,
    4,
    'workspace_exec',
    'printf forbidden > ' + JSON.stringify(deniedMarker),
  );
  assert.equal(forbidden.status, 200);
  const denialText = await forbidden.text();
  // MCP SDK serializes the error message (not the internal broker error code).
  assert.match(denialText, /Worker does not allow operation 'workspace.exec'/);
  assert.equal(fs.existsSync(deniedMarker), false, 'Denied command must never execute');
  active.worker.capabilities = ['shell.inspect', 'workspace.exec'];

  const db = connection.getDb();
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  db.prepare('UPDATE mcp_oauth_access_tokens SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
  const expired = await request(token, 5, 'workspace_exec', 'true');
  assert.equal(expired.status, 401);

  await terminate();
  await waitUntil(() => !broker.isOnline(state.worker_id), 5000);
  assert.equal((await fetch(base + '/readyz', { headers: forwarded })).status, 200);
});
