import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync, type ChildProcess } from 'node:child_process';

export type Sandbox = {
  name: string;
  root: string;
  volume: string;
  dbPath: string;
  secret: string;
  domain: string;
  keyPath: string;
  certPath: string;
  child?: ChildProcess;
  http?: string;
  wss?: string;
  logs: string;
};

export function sandboxRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w3-railway-acceptance-'));
}
export function makeCertificate(root: string): { keyPath: string; certPath: string } {
  const keyPath = path.join(root, 'loopback.key');
  const certPath = path.join(root, 'loopback.crt');
  const cert = spawnSync(
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
      keyPath,
      '-out',
      certPath,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(cert.status, 0, cert.stderr || 'OpenSSL must be installed');
  return { keyPath, certPath };
}
export function makeSandbox(
  root: string,
  name: string,
  cert: { keyPath: string; certPath: string },
  options: { secret?: string; volume?: string } = {},
): Sandbox {
  const volume = options.volume || path.join(root, name + '-volume');
  fs.mkdirSync(volume, { recursive: true, mode: 0o700 });
  return {
    name,
    root,
    volume,
    dbPath: path.join(volume, 'bot_report.sqlite'),
    secret: options.secret || crypto.randomBytes(32).toString('base64url'),
    domain: name.toLowerCase() + '.sandbox.up.railway.app',
    ...cert,
    logs: '',
  };
}
export async function startSandbox(s: Sandbox): Promise<void> {
  assert.equal(s.child, undefined);
  const script = path.join(process.cwd(), 'dist/scripts/verify-railway-sandbox-child.cjs');
  assert.ok(fs.existsSync(script), 'Build the project before the sandbox integration test');
  const child = fork(script, [], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: s.root,
      NODE_ENV: 'test',
      MCP_PLATFORM: 'railway',
      MCP_SETUP_SECRET: s.secret,
      RAILWAY_VOLUME_MOUNT_PATH: s.volume,
      DATABASE_PATH: s.dbPath,
      RAILWAY_PUBLIC_DOMAIN: s.domain,
      TRUST_PROXY: '1',
      HOST: '127.0.0.1',
      PORT: '0',
      MCP_ENABLED: 'true',
      W3_TEST_KEY_PATH: s.keyPath,
      W3_TEST_CERT_PATH: s.certPath,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  s.child = child;
  child.stderr?.on('data', (chunk: Buffer) => {
    s.logs = (s.logs + chunk.toString('utf8')).slice(-4000);
  });
  try {
    const answer = await new Promise<{ httpPort: number; tlsPort: number }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Sandbox startup timeout: ' + s.logs)),
        15000,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        child.off('message', message);
        child.off('exit', exit);
        child.off('error', fail);
      };
      const message = (data: unknown) => {
        if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'ready') return;
        const info = data as unknown as { httpPort: number; tlsPort: number };
        cleanup();
        resolve(info);
      };
      const exit = (code: number | null) => {
        cleanup();
        reject(new Error('Sandbox exited ' + code + ': ' + s.logs));
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      child.on('message', message);
      child.once('exit', exit);
      child.once('error', fail);
    });
    s.http = 'http://127.0.0.1:' + answer.httpPort;
    s.wss = 'wss://127.0.0.1:' + answer.tlsPort + '/worker/v1/connect';
  } catch (e) {
    child.kill('SIGKILL');
    s.child = undefined;
    throw e;
  }
}
let sequence = 1;
export async function rpc<T = unknown>(
  s: Sandbox,
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const child = s.child;
  assert.ok(child && child.connected, 'Sandbox process must be connected');
  const id = sequence++;
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('IPC timeout ' + op + ': ' + s.logs));
    }, 6000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', receive);
      child.off('exit', exited);
    };
    const receive = (response: unknown) => {
      if (!response || typeof response !== 'object' || !('id' in response) || response.id !== id)
        return;
      const result = response as unknown as {
        ok: boolean;
        result?: T;
        error?: { code: string; message: string };
      };
      cleanup();
      if (result.ok) resolve(result.result as T);
      else {
        const error = new Error(result.error?.message || op + ' failed');
        Object.assign(error, { code: result.error?.code });
        reject(error);
      }
    };
    const exited = () => {
      cleanup();
      reject(new Error('Sandbox exited during ' + op + ': ' + s.logs));
    };
    child.on('message', receive);
    child.once('exit', exited);
    child.send({ id, op, args }, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}
export async function stopSandbox(s: Sandbox): Promise<void> {
  const child = s.child;
  if (!child) return;
  try {
    if (child.connected) await rpc(s, 'stop');
  } catch {}
  if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exit;
    clearTimeout(timer);
  }
  s.child = undefined;
  s.http = undefined;
  s.wss = undefined;
}
export function cleanupRoot(root: string): void {
  fs.chmodSync(root, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
}
export function cookie(r: Response): string {
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
export function csrf(html: string): string {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
}
export const forwarded = { 'x-forwarded-proto': 'https' };
export async function setupOwner(s: Sandbox, password: string, key = s.secret): Promise<number> {
  const page = await fetch(s.http + '/setup', { headers: forwarded });
  assert.equal(page.status, 200);
  const c = cookie(page);
  const token = csrf(await page.text());
  assert.ok(c && token);
  const result = await fetch(s.http + '/setup', {
    method: 'POST',
    redirect: 'manual',
    headers: { ...forwarded, cookie: c, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: token,
      setup_key: key,
      password,
      confirm_password: password,
    }).toString(),
  });
  return result.status;
}
export async function loginOwner(
  s: Sandbox,
  password: string,
): Promise<{ status: number; sid: string }> {
  const page = await fetch(s.http + '/login', { headers: forwarded });
  const c = cookie(page);
  const token = csrf(await page.text());
  assert.ok(c && token);
  const r = await fetch(s.http + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { ...forwarded, cookie: c, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: token,
      username: 'admin',
      password,
      returnTo: '/',
    }).toString(),
  });
  return { status: r.status, sid: cookie(r) };
}
export async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5500): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for isolated Worker state');
}
