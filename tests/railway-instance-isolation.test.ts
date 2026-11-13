import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import {
  sandboxRoot,
  makeCertificate,
  makeSandbox,
  startSandbox,
  stopSandbox,
  cleanupRoot,
  setupOwner,
  loginOwner,
  csrf,
  forwarded,
  waitFor,
  rpc,
  type Sandbox,
} from '../scripts/verify-railway-harness';

type OAuthClient = { client: { client_id: string }; rawSecret: string };
type TokenReply = { access_token: string; refresh_token: string };
type WorkerReply = { worker_id: string; profile: { name: string; id: string } };
type WorkerJob = {
  type?: string;
  job_id?: string;
  operation?: string;
  args?: { command?: string };
};

function signedHeaders(workerId: string, key: crypto.KeyObject) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(20).toString('base64url');
  const content = [workerId, timestamp, nonce, '/worker/v1/connect'].join('\n');
  return {
    'x-br-worker-id': workerId,
    'x-br-worker-timestamp': timestamp,
    'x-br-worker-nonce': nonce,
    'x-br-worker-signature': crypto.sign(null, Buffer.from(content), key).toString('base64'),
  };
}

async function connectWorker(
  s: Sandbox,
  workerId: string,
  key: crypto.KeyObject,
  response: string,
  commands: string[],
): Promise<WebSocket> {
  assert.ok(s.wss);
  const socket = new WebSocket(s.wss, {
    ca: fs.readFileSync(s.certPath),
    headers: signedHeaders(workerId, key),
  });
  socket.on('message', (bytes) => {
    const data = Buffer.isBuffer(bytes)
      ? bytes
      : Array.isArray(bytes)
        ? Buffer.concat(bytes)
        : Buffer.from(bytes);
    const job = JSON.parse(data.toString('utf8')) as WorkerJob;
    if (job.type !== 'job' || !job.job_id) return;
    commands.push(job.args?.command || '');
    socket.send(
      JSON.stringify({
        type: 'result',
        job_id: job.job_id,
        ok: true,
        result: { stdout: response, exit_code: 0 },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await waitFor(() => rpc<boolean>(s, 'online', { workerId }));
  return socket;
}
async function deniedForeignConnect(s: Sandbox, workerId: string, key: crypto.KeyObject) {
  assert.ok(s.wss);
  const socket = new WebSocket(s.wss, {
    ca: fs.readFileSync(s.certPath),
    headers: signedHeaders(workerId, key),
  });
  const status = await new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_req, res) => {
      const code = res.statusCode || 0;
      res.resume();
      resolve(code);
    });
    socket.once('open', () => reject(new Error('Foreign Worker connected')));
    socket.once('error', reject);
  });
  assert.equal(status, 401);
}
async function enroll(s: Sandbox, token: string, key: crypto.KeyObject, label: string) {
  const res = await fetch(s.http + '/worker/v1/enroll', {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      name: label + '-Worker',
      public_key: key.export({ format: 'pem', type: 'spki' }).toString(),
      capabilities: ['workspace.exec', 'shell.inspect'],
      create_profile: true,
      profile_name: label + '-Profile',
    }),
  });
  const raw = await res.text();
  assert.equal(res.status, 201, raw);
  return JSON.parse(raw) as WorkerReply;
}
async function grant(s: Sandbox, sid: string, client: OAuthClient): Promise<TokenReply> {
  const redirect = 'http://localhost:40000/oauth/callback';
  const verifier = crypto.randomBytes(40).toString('base64url');
  const params = new URLSearchParams({
    client_id: client.client.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'bot_report.read bot_report.terminal offline_access',
    state: 'instance-' + s.name,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: 'https://' + s.domain + '/mcp',
  });
  const page = await fetch(s.http + '/oauth/authorize?' + params.toString(), {
    headers: { ...forwarded, cookie: sid },
    redirect: 'manual',
  });
  assert.equal(page.status, 200);
  const body = new URLSearchParams(params);
  body.set('_csrf', csrf(await page.text()));
  body.set('action', 'allow');
  const consent = await fetch(s.http + '/oauth/authorize', {
    method: 'POST',
    redirect: 'manual',
    headers: { ...forwarded, cookie: sid, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get('location') || '').searchParams.get('code');
  assert.ok(code);
  const reply = await fetch(s.http + '/oauth/token', {
    method: 'POST',
    headers: authHeaders(client),
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: 'https://' + s.domain + '/mcp',
    }).toString(),
  });
  const raw = await reply.text();
  assert.equal(reply.status, 200, raw);
  const tokens = JSON.parse(raw) as TokenReply;
  assert.ok(tokens.access_token && tokens.refresh_token);
  return tokens;
}
function authHeaders(client: OAuthClient) {
  return {
    ...forwarded,
    'content-type': 'application/x-www-form-urlencoded',
    authorization:
      'Basic ' + Buffer.from(client.client.client_id + ':' + client.rawSecret).toString('base64'),
  };
}
async function refresh(s: Sandbox, client: OAuthClient, refreshToken: string) {
  return fetch(s.http + '/oauth/token', {
    method: 'POST',
    headers: authHeaders(client),
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
}
async function mcpCall(s: Sandbox, accessToken: string, profile: string, command: string) {
  return fetch(s.http + '/mcp', {
    method: 'POST',
    headers: {
      ...forwarded,
      authorization: 'Bearer ' + accessToken,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'workspace_exec', arguments: { profile, command } },
    }),
  });
}

void test('two independently booted Railway SQLite instances isolate owner, sessions, OAuth and signed Workers', async (t) => {
  const root = sandboxRoot();
  const cert = makeCertificate(root);
  const a = makeSandbox(root, 'alpha', cert);
  const b = makeSandbox(root, 'beta', cert);
  const aPassword = 'A-Isolated-Owner-2026!';
  const bPassword = 'B-Isolated-Owner-2026!';
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await Promise.all([stopSandbox(a), stopSandbox(b)]);
    cleanupRoot(root);
  });
  assert.notEqual(a.secret, b.secret);
  assert.notEqual(a.dbPath, b.dbPath);
  await Promise.all([startSandbox(a), startSandbox(b)]);
  assert.notEqual(a.http, b.http);
  assert.notEqual(a.wss, b.wss);
  assert.equal(await setupOwner(b, bPassword, a.secret), 403);
  assert.equal(await setupOwner(a, aPassword), 303);
  assert.equal(await setupOwner(b, bPassword), 303);
  const aLogin = await loginOwner(a, aPassword);
  const bLogin = await loginOwner(b, bPassword);
  assert.equal(aLogin.status, 302);
  assert.equal(bLogin.status, 302);
  assert.notEqual(aLogin.sid, bLogin.sid);
  assert.notEqual((await loginOwner(b, aPassword)).status, 302);
  const cookieAcross = await fetch(b.http + '/admin', {
    redirect: 'manual',
    headers: { ...forwarded, cookie: aLogin.sid },
  });
  assert.notEqual(cookieAcross.status, 200, 'A owner session cannot authenticate on B');
  assert.equal((await fetch(a.http + '/readyz', { headers: forwarded })).status, 200);
  assert.equal((await fetch(b.http + '/readyz', { headers: forwarded })).status, 200);

  const aEnroll = await rpc<{ token: string }>(a, 'enrollmentToken');
  const bEnroll = await rpc<{ token: string }>(b, 'enrollmentToken');
  const keysA = crypto.generateKeyPairSync('ed25519');
  const keysB = crypto.generateKeyPairSync('ed25519');
  const invalidEnrollment = await fetch(b.http + '/worker/v1/enroll', {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/json' },
    body: JSON.stringify({
      token: aEnroll.token,
      name: 'Foreign-Worker',
      public_key: keysA.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      capabilities: ['workspace.exec'],
    }),
  });
  assert.equal(invalidEnrollment.status, 401);
  const workerA = await enroll(a, aEnroll.token, keysA.publicKey, 'Alpha');
  const workerB = await enroll(b, bEnroll.token, keysB.publicKey, 'Beta');
  assert.notEqual(workerA.worker_id, workerB.worker_id);
  assert.equal(await rpc(b, 'worker', { workerId: workerA.worker_id }), null);
  assert.equal(await rpc(a, 'worker', { workerId: workerB.worker_id }), null);

  await deniedForeignConnect(b, workerA.worker_id, keysA.privateKey);
  await deniedForeignConnect(a, workerB.worker_id, keysB.privateKey);
  const jobsA: string[] = [];
  const jobsB: string[] = [];
  const socketA = await connectWorker(a, workerA.worker_id, keysA.privateKey, 'A_ONLY', jobsA);
  const socketB = await connectWorker(b, workerB.worker_id, keysB.privateKey, 'B_ONLY', jobsB);
  sockets.push(socketA, socketB);
  assert.deepEqual(
    await rpc(a, 'dispatch', { workerId: workerA.worker_id, command: 'printf A_ONLY' }),
    { stdout: 'A_ONLY', exit_code: 0 },
  );
  assert.deepEqual(
    await rpc(b, 'dispatch', { workerId: workerB.worker_id, command: 'printf B_ONLY' }),
    { stdout: 'B_ONLY', exit_code: 0 },
  );
  await assert.rejects(
    rpc(a, 'dispatch', { workerId: workerB.worker_id, command: 'printf NEVER' }),
  );
  await assert.rejects(
    rpc(b, 'dispatch', { workerId: workerA.worker_id, command: 'printf NEVER' }),
  );

  const scopes = ['bot_report.read', 'bot_report.terminal', 'offline_access'];
  const clientA = await rpc<OAuthClient>(a, 'oauthRegister', {
    displayName: 'Alpha isolated OAuth',
    principalId: 'principal:alpha',
    profileId: workerA.profile.id,
    redirectUris: ['http://localhost:40000/oauth/callback'],
    allowedScopes: scopes,
  });
  const clientB = await rpc<OAuthClient>(b, 'oauthRegister', {
    displayName: 'Beta isolated OAuth',
    principalId: 'principal:beta',
    profileId: workerB.profile.id,
    redirectUris: ['http://localhost:40000/oauth/callback'],
    allowedScopes: scopes,
  });
  const tokensA = await grant(a, aLogin.sid, clientA);
  const tokensB = await grant(b, bLogin.sid, clientB);
  const foreignClient = await refresh(b, clientA, tokensA.refresh_token);
  assert.equal(foreignClient.status, 401);
  const foreignRefresh = await refresh(b, clientB, tokensA.refresh_token);
  assert.equal(foreignRefresh.status, 400);
  const rotated = await refresh(a, clientA, tokensA.refresh_token);
  assert.equal(rotated.status, 200);
  assert.ok(((await rotated.json()) as TokenReply).refresh_token !== tokensA.refresh_token);
  assert.equal((await refresh(a, clientA, tokensA.refresh_token)).status, 400);

  const deniedA = await mcpCall(b, tokensA.access_token, workerB.profile.name, 'printf NEVER');
  const deniedB = await mcpCall(a, tokensB.access_token, workerA.profile.name, 'printf NEVER');
  assert.equal(deniedA.status, 401);
  assert.equal(deniedB.status, 401);
  const callA = await mcpCall(a, tokensA.access_token, workerA.profile.name, 'printf A_ONLY');
  const callB = await mcpCall(b, tokensB.access_token, workerB.profile.name, 'printf B_ONLY');
  assert.equal(callA.status, 200);
  assert.match(await callA.text(), /A_ONLY/);
  assert.equal(callB.status, 200);
  assert.match(await callB.text(), /B_ONLY/);
  assert.ok(jobsA.length >= 2 && jobsB.length >= 2);
  assert.equal(
    jobsA.some((cmd) => cmd.includes('B_ONLY') || cmd.includes('NEVER')),
    false,
  );
  assert.equal(
    jobsB.some((cmd) => cmd.includes('A_ONLY') || cmd.includes('NEVER')),
    false,
  );

  await rpc(a, 'restrict', { workerId: workerA.worker_id, capabilities: ['shell.inspect'] });
  await assert.rejects(
    rpc(a, 'dispatch', { workerId: workerA.worker_id, command: 'printf DENIED' }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_CAPABILITY_DENIED',
  );
  assert.equal(
    jobsA.some((cmd) => cmd.includes('DENIED')),
    false,
  );
  // A restart must not swap a session, credential, database or Worker identity with B.
  socketA.terminate();
  await stopSandbox(a);
  await startSandbox(a);
  const aCookieAfterRestart = await fetch(a.http + '/admin', {
    headers: { ...forwarded, cookie: aLogin.sid },
    redirect: 'manual',
  });
  assert.equal(aCookieAfterRestart.status, 200);
  assert.equal(
    (await rpc<{ id: string }>(a, 'worker', { workerId: workerA.worker_id })).id,
    workerA.worker_id,
  );
  const reconnect = await connectWorker(
    a,
    workerA.worker_id,
    keysA.privateKey,
    'A_RECONNECTED',
    jobsA,
  );
  sockets.push(reconnect);
  assert.deepEqual(
    await rpc(a, 'dispatch', {
      workerId: workerA.worker_id,
      command: 'printf A_RECONNECTED',
    }),
    { stdout: 'A_RECONNECTED', exit_code: 0 },
  );
  assert.equal(await rpc<boolean>(b, 'online', { workerId: workerB.worker_id }), true);
  const dbA = new Database(a.dbPath, { readonly: true, fileMustExist: true });
  const dbB = new Database(b.dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(dbA.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(dbB.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(
      (
        dbA
          .prepare('SELECT COUNT(*) AS n FROM mcp_oauth_clients WHERE client_id=?')
          .get(clientB.client.client_id) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        dbB
          .prepare('SELECT COUNT(*) AS n FROM mcp_oauth_clients WHERE client_id=?')
          .get(clientA.client.client_id) as { n: number }
      ).n,
      0,
    );
  } finally {
    dbA.close();
    dbB.close();
  }
});
