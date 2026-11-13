import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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

type LocalWorker = {
  child?: ChildProcess;
  id: string;
  name: string;
  workspace: string;
  home: string;
};
type Client = { client: { client_id: string }; rawSecret: string };
function workerEnv(home: string, certPath: string) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    BOT_REPORT_WORKER_HOME: home,
    BOT_REPORT_WORKER_SKIP_SERVICE: '1',
    SSL_CERT_FILE: certPath,
    GOTOOLCHAIN: 'auto',
    CGO_ENABLED: '0',
  };
}
function httpsOrigin(s: Sandbox) {
  assert.ok(s.wss);
  return s.wss.replace('wss://', 'https://').replace('/worker/v1/connect', '');
}
async function runCli(binary: string, args: string[], cwd: string, env: Record<string, string>) {
  return await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const p = spawn(binary, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2500);
    });
    p.once('error', reject);
    p.once('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}
async function enrollGo(
  s: Sandbox,
  binary: string,
  label: string,
  root: string,
): Promise<LocalWorker> {
  const home = path.join(root, label + '-home');
  const workspace = path.join(root, label + '-workspace');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  const enrollment = await rpc<{ token: string }>(s, 'enrollmentToken');
  const result = await runCli(
    binary,
    [
      'login',
      '--server',
      httpsOrigin(s),
      '--token',
      enrollment.token,
      '--roots',
      workspace,
      '--name',
      'W3-' + label,
      '--profile',
      label + '-Profile',
      '--allow-shell',
      '--no-start',
    ],
    workspace,
    workerEnv(home, s.certPath),
  );
  assert.equal(result.code, 0, 'Real Go enrollment failed: ' + result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')) as {
    worker_id: string;
  };
  assert.ok(state.worker_id);
  return { home, workspace, id: state.worker_id, name: label + '-Profile' };
}
function runWorker(worker: LocalWorker, binary: string, certPath: string) {
  worker.child = spawn(binary, ['run'], {
    cwd: worker.workspace,
    env: workerEnv(worker.home, certPath),
    stdio: 'ignore',
  });
  worker.child.once('error', (error) => {
    throw error;
  });
}
async function stopWorker(worker: LocalWorker) {
  const child = worker.child;
  if (!child) return;
  if (child.exitCode === null && !child.killed) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
  }
  worker.child = undefined;
}
async function grant(s: Sandbox, sid: string, client: Client) {
  const verifier = crypto.randomBytes(40).toString('base64url');
  const redirectUri = 'http://localhost:40000/oauth/callback';
  const params = new URLSearchParams({
    client_id: client.client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'bot_report.read bot_report.terminal',
    state: 'w3-' + s.name,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: 'https://' + s.domain + '/mcp',
  });
  const page = await fetch(s.http + '/oauth/authorize?' + params.toString(), {
    headers: { ...forwarded, cookie: sid },
    redirect: 'manual',
  });
  assert.equal(page.status, 200);
  params.set('_csrf', csrf(await page.text()));
  params.set('action', 'allow');
  const consent = await fetch(s.http + '/oauth/authorize', {
    method: 'POST',
    redirect: 'manual',
    headers: { ...forwarded, cookie: sid, 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get('location') || '').searchParams.get('code');
  assert.ok(code);
  const issued = await fetch(s.http + '/oauth/token', {
    method: 'POST',
    headers: {
      ...forwarded,
      'content-type': 'application/x-www-form-urlencoded',
      authorization:
        'Basic ' + Buffer.from(client.client.client_id + ':' + client.rawSecret).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: 'https://' + s.domain + '/mcp',
    }).toString(),
  });
  const raw = await issued.text();
  assert.equal(issued.status, 200, raw);
  const tokens = JSON.parse(raw) as { access_token: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}
async function mcpCall(s: Sandbox, token: string, profile: string, command: string, cwd: string) {
  return fetch(s.http + '/mcp', {
    method: 'POST',
    headers: {
      ...forwarded,
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'workspace_exec', arguments: { profile, command, cwd } },
    }),
  });
}
function chmodRecursive(directory: string) {
  fs.chmodSync(directory, 0o700);
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isDirectory()) chmodRecursive(path.join(directory, item.name));
  }
}

void test('two real, separately enrolled Go Workers execute isolated harmless MCP over loopback WSS', async (t) => {
  if (process.env.BOT_REPORT_W3_T04_GO_E2E !== '1') {
    t.skip('Set BOT_REPORT_W3_T04_GO_E2E=1 in a disposable sandbox; mandatory in W3 CI');
    return;
  }
  assert.equal(spawnSync('go', ['version'], { stdio: 'ignore' }).status, 0);
  assert.equal(spawnSync('openssl', ['version'], { stdio: 'ignore' }).status, 0);
  const root = sandboxRoot();
  const cert = makeCertificate(root);
  const a = makeSandbox(root, 'w3-go-alpha', cert);
  const b = makeSandbox(root, 'w3-go-beta', cert);
  const workers: LocalWorker[] = [];
  t.after(async () => {
    await Promise.all(workers.map(stopWorker));
    await Promise.all([stopSandbox(a), stopSandbox(b)]);
    // Go module downloads may make temporary directories read-only.
    chmodRecursive(root);
    cleanupRoot(root);
  });
  const binary = path.join(root, 'w3-isolated-go-worker');
  const build = spawnSync('go', ['build', '-trimpath', '-o', binary, '.'], {
    cwd: path.join(process.cwd(), 'worker-go'),
    env: workerEnv(root, cert.certPath),
    encoding: 'utf8',
    timeout: 240000,
  });
  assert.equal(build.status, 0, build.stderr || build.error?.message || 'Go build failed');
  await Promise.all([startSandbox(a), startSandbox(b)]);
  assert.equal(await setupOwner(a, 'Real-Go-A-Owner-2026!'), 303);
  assert.equal(await setupOwner(b, 'Real-Go-B-Owner-2026!'), 303);
  const aLogin = await loginOwner(a, 'Real-Go-A-Owner-2026!');
  const bLogin = await loginOwner(b, 'Real-Go-B-Owner-2026!');
  assert.equal(aLogin.status, 302);
  assert.equal(bLogin.status, 302);
  const workerA = await enrollGo(a, binary, 'Alpha', root);
  const workerB = await enrollGo(b, binary, 'Beta', root);
  workers.push(workerA, workerB);
  assert.notEqual(workerA.id, workerB.id);
  assert.equal(await rpc(b, 'worker', { workerId: workerA.id }), null);
  assert.equal(await rpc(a, 'worker', { workerId: workerB.id }), null);
  workers.forEach((w) => runWorker(w, binary, cert.certPath));
  await waitFor(() => rpc<boolean>(a, 'online', { workerId: workerA.id }), 20000);
  await waitFor(() => rpc<boolean>(b, 'online', { workerId: workerB.id }), 20000);
  const pA = await rpc<{ id: string }>(a, 'profile', { name: workerA.name });
  const pB = await rpc<{ id: string }>(b, 'profile', { name: workerB.name });
  assert.ok(pA?.id && pB?.id);
  const scopes = ['bot_report.read', 'bot_report.terminal'];
  const clientA = await rpc<Client>(a, 'oauthRegister', {
    displayName: 'Real W3 A client',
    principalId: 'principal:go-a',
    profileId: pA.id,
    redirectUris: ['http://localhost:40000/oauth/callback'],
    allowedScopes: scopes,
  });
  const clientB = await rpc<Client>(b, 'oauthRegister', {
    displayName: 'Real W3 B client',
    principalId: 'principal:go-b',
    profileId: pB.id,
    redirectUris: ['http://localhost:40000/oauth/callback'],
    allowedScopes: scopes,
  });
  const tokenA = await grant(a, aLogin.sid, clientA);
  const tokenB = await grant(b, bLogin.sid, clientB);
  const crossA = await mcpCall(b, tokenA, workerB.name, 'printf NEVER', workerB.workspace);
  const crossB = await mcpCall(a, tokenB, workerA.name, 'printf NEVER', workerA.workspace);
  assert.equal(crossA.status, 401);
  assert.equal(crossB.status, 401);
  const commandA = await mcpCall(
    a,
    tokenA,
    workerA.name,
    'printf W3_GO_ALPHA_ONLY',
    workerA.workspace,
  );
  const commandB = await mcpCall(
    b,
    tokenB,
    workerB.name,
    'printf W3_GO_BETA_ONLY',
    workerB.workspace,
  );
  assert.equal(commandA.status, 200);
  assert.match(await commandA.text(), /W3_GO_ALPHA_ONLY/);
  assert.equal(commandB.status, 200);
  assert.match(await commandB.text(), /W3_GO_BETA_ONLY/);
  await assert.rejects(rpc(a, 'dispatch', { workerId: workerB.id, command: 'printf NEVER' }));
  await assert.rejects(rpc(b, 'dispatch', { workerId: workerA.id, command: 'printf NEVER' }));
  await rpc(a, 'restrict', { workerId: workerA.id, capabilities: ['shell.inspect'] });
  const blocked = await mcpCall(a, tokenA, workerA.name, 'printf NEVER', workerA.workspace);
  assert.equal(blocked.status, 200);
  assert.match(await blocked.text(), /Worker does not allow operation 'workspace.exec'/);
  await stopWorker(workerA);
  await waitFor(async () => !(await rpc<boolean>(a, 'online', { workerId: workerA.id })));
  runWorker(workerA, binary, cert.certPath);
  await waitFor(() => rpc<boolean>(a, 'online', { workerId: workerA.id }), 20000);
  assert.equal(await rpc<boolean>(b, 'online', { workerId: workerB.id }), true);
  const after = await mcpCall(
    a,
    tokenA,
    workerA.name,
    'printf W3_GO_RECONNECTED',
    workerA.workspace,
  );
  assert.equal(after.status, 200);
  assert.match(await after.text(), /W3_GO_RECONNECTED/);
});
