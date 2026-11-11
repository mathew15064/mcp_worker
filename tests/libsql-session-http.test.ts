import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSessionMiddleware } from '../src/middleware/createSessionMiddleware';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { LibsqlSessionStore } from '../src/db/libsqlSessionStore';

const SECRET = 'test-session-middleware-shared-stable-secret-2026';

async function makeApp(store: LibsqlSessionStore): Promise<{ base: string; server: Server }> {
  const app = express();
  app.use(createSessionMiddleware({ store, secret: SECRET, secureCookie: false }));
  app.get('/login', (req, res) => {
    req.session.userId = 'admin-1';
    req.session.csrfToken = 'csrf-credential-123';
    req.session.save((error) => {
      if (error) return res.status(500).end();
      return res.json({ ok: true });
    });
  });
  app.get('/whoami', (req, res) => {
    res.json({ userId: req.session.userId || null, csrf: req.session.csrfToken || null });
  });
  app.post('/logout', (req, res) => {
    req.session.destroy((error) => {
      if (error) return res.status(500).end();
      return res.json({ ok: true });
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}` };
}

void test('same Admin login cookie works across two independent Express instances and revocation propagates', async () => {
  const { createClient } = await import('@libsql/client');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp_worker_http_sessions_'));
  const url = `file:${path.join(directory, 'shared.sqlite')}`;
  const a = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  const b = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  const storeA = new LibsqlSessionStore({ adapter: a, secret: SECRET });
  const storeB = new LibsqlSessionStore({ adapter: b, secret: SECRET });
  const servers: Server[] = [];
  try {
    await storeA.initialize();
    await storeB.initialize();
    const first = await makeApp(storeA);
    const second = await makeApp(storeB);
    servers.push(first.server, second.server);
    const login = await fetch(`${first.base}/login`);
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie || !cookie.startsWith('bot_report.sid='))
      throw new Error('Missing Admin session cookie');
    const whoami = await fetch(`${second.base}/whoami`, { headers: { cookie } });
    assert.equal(whoami.status, 200);
    assert.deepEqual(await whoami.json(), { userId: 'admin-1', csrf: 'csrf-credential-123' });
    const logout = await fetch(`${second.base}/logout`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(logout.status, 200);
    const after = await fetch(`${first.base}/whoami`, { headers: { cookie } });
    assert.deepEqual(await after.json(), { userId: null, csrf: null });
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
    await a.close();
    await b.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
