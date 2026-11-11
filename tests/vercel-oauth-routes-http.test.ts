import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { createSessionMiddleware } from '../src/middleware/createSessionMiddleware';
import { csrfProtection } from '../src/middleware/csrfMiddleware';
import oauthRoutes from '../src/routes/mcpOAuthRoutes';
import {
  buildPreviewOAuthRouteConfig,
  createPreviewOAuthRuntime,
} from '../src/deployment/vercelOAuthRuntime';
import { provisionPreviewDatabase } from '../src/deployment/previewProvisioning';
import type { DeploymentEnvironment } from '../src/deployment/profile';

const env: DeploymentEnvironment = {
  VERCEL_ENV: 'preview',
  VERCEL_PREVIEW_ENABLED: 'true',
  DEPLOYMENT_MODE: 'vercel',
  STORAGE_DRIVER: 'libsql',
  EXECUTION_BACKEND: 'sandbox',
  SESSION_SECRET: 'test-oauth-express-routing-stable-secret-for-ci',
  MCP_PUBLIC_BASE_URL: 'https://preview.example.invalid',
  TURSO_DATABASE_URL: 'libsql://test-preview.example.invalid',
  TURSO_AUTH_TOKEN: 'test-only-token',
  VERCEL_PREVIEW_PROBE_TOKEN: 'preview-runtime-test-probe-token-0123456789',
  VERCEL_OWNER_CLAIM_TOKEN: 'test-owner-proof-only-not-real-abcdefghijklmnopqrstuvwxyz',
  VERCEL_PREVIEW_PROVISION_ACK: 'yes-create-disposable-preview-schema',
  VERCEL_PREVIEW_PROVISION_CONFIRM_HOST: 'test-preview.example.invalid',
};

type Runtime = Awaited<ReturnType<typeof createPreviewOAuthRuntime>>;
const ownerPassword = 'test-owner-route-password-only-ci-0123456789';

async function makeServer(runtime: Runtime) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  // HTTP-only fixture; production Vercel must use secure-cookie=true and HTTPS.
  app.use(
    createSessionMiddleware({
      store: runtime.sessions,
      secret: env.SESSION_SECRET || '',
      secureCookie: false,
    }),
  );
  app.use(csrfProtection);
  // Test fixture only: a real owner is authenticated using the new owner
  // service, then the old session ID is regenerated before login is stored.
  // No such endpoint is mounted in the production app or Vercel Function.
  app.get('/test-only-login', async (req, res) => {
    try {
      const owner = await runtime.owner.authenticate('test-route-owner', ownerPassword);
      if (!owner) return res.sendStatus(401);
      req.session.regenerate((error) => {
        if (error) return res.sendStatus(500);
        req.session.role = owner.role;
        req.session.userId = owner.id;
        req.session.sessionVersion = owner.session_version;
        req.session.authSource = owner.auth_source;
        req.session.csrfToken = 'test-csrf-token';
        req.session.save((err) => {
          if (err) return res.sendStatus(500);
          return res.json({ success: true });
        });
      });
    } catch {
      return res.sendStatus(500);
    }
  });
  const route = oauthRoutes.createOAuthRouter({
    service: runtime.oauth,
    repository: runtime.repository,
    config: buildPreviewOAuthRouteConfig(env),
    database: { isOperational: () => true, status: () => ({ state: 'READY' }) },
    identity: (req) => runtime.owner.currentIdentity(req.session),
  });
  app.use(route);
  app.use((_req, res) => res.sendStatus(404));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

void test('injected OAuth routes exchange/revoke PKCE tokens across isolated Express instances with CSRF consent', async () => {
  const { createClient } = await import('@libsql/client');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p4_route_test_'));
  const url = `file:${path.join(directory, 'shared.sqlite')}`;
  const adapter = new LibsqlAdapter(createClient({ url }), { ownsClient: true });
  const factory = () =>
    Promise.resolve(new LibsqlAdapter(createClient({ url }), { ownsClient: true }));
  const servers: Server[] = [];
  let a: Runtime | null = null;
  let b: Runtime | null = null;
  try {
    await adapter.exec('PRAGMA journal_mode=WAL');
    await provisionPreviewDatabase(env, () => Promise.resolve(adapter));
    a = await createPreviewOAuthRuntime(env, factory);
    b = await createPreviewOAuthRuntime(env, factory);
    await a.owner.claim({
      proof: env.VERCEL_OWNER_CLAIM_TOKEN,
      username: 'test-route-owner',
      password: ownerPassword,
    });
    const first = await makeServer(a);
    const second = await makeServer(b);
    servers.push(first.server, second.server);

    const client = await a.oauth.registerClient({
      displayName: 'e2e-test',
      redirectUris: ['https://callback.example.invalid/done'],
      allowedScopes: ['bot_report.read', 'offline_access'],
    });
    if (!client.client) throw new Error('Missing client');
    const challengeVerifier = 'route-abcdefghijklmnopqrstuvwxyz-0123456789';
    const challenge = crypto.createHash('sha256').update(challengeVerifier).digest('base64url');
    const args = new URLSearchParams({
      client_id: client.client.client_id,
      redirect_uri: 'https://callback.example.invalid/done',
      response_type: 'code',
      scope: 'bot_report.read offline_access',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'csrf-state-test',
      resource: a.policy.resourceUrl,
    });
    const unauthorized = await fetch(`${first.url}/oauth/authorize?${args}`, {
      redirect: 'manual',
    });
    assert.equal(unauthorized.status, 302);
    assert.equal(unauthorized.headers.get('location'), '/login');

    const login = await fetch(first.url + '/test-only-login');
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie) throw new Error('Fixture login cookie was not created');

    // Consent can be rendered by the other instance using a shared session.
    const consent = await fetch(`${second.url}/oauth/authorize?${args}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(consent.status, 200);
    assert.match(await consent.text(), /test-csrf-token/);

    const denied = await fetch(second.url + '/oauth/authorize', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: client.client.client_id,
        redirect_uri: 'https://callback.example.invalid/done',
        scope: 'bot_report.read offline_access',
        state: 'csrf-state-test',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: a.policy.resourceUrl,
        action: 'allow',
      }),
    });
    assert.equal(denied.status, 403);

    const authorized = await fetch(second.url + '/oauth/authorize', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        client_id: client.client.client_id,
        redirect_uri: 'https://callback.example.invalid/done',
        scope: 'bot_report.read offline_access',
        state: 'csrf-state-test',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: a.policy.resourceUrl,
        action: 'allow',
        _csrf: 'test-csrf-token',
      }),
    });
    assert.equal(authorized.status, 302);
    const redirect = authorized.headers.get('location');
    if (!redirect) throw new Error('Missing authorized redirect');
    const target = new URL(redirect);
    assert.equal(target.origin, 'https://callback.example.invalid');
    assert.equal(target.searchParams.get('state'), 'csrf-state-test');
    const code = target.searchParams.get('code');
    if (!code) throw new Error('Missing authorization code');

    const exchange = await fetch(first.url + '/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client.client_id,
        client_secret: client.rawSecret,
        redirect_uri: 'https://callback.example.invalid/done',
        code_verifier: challengeVerifier,
        resource: a.policy.resourceUrl,
        code,
      }),
    });
    assert.equal(exchange.status, 200);
    assert.equal(exchange.headers.get('cache-control'), 'no-store');
    const tokens = (await exchange.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    assert.ok(tokens.access_token);
    if (!tokens.refresh_token) throw new Error('Missing refresh token');

    const revoked = await fetch(second.url + '/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client.client_id,
        client_secret: client.rawSecret,
        token: tokens.access_token,
        token_type_hint: 'access_token',
      }),
    });
    assert.equal(revoked.status, 200);
    const hashed = crypto.createHash('sha256').update(tokens.access_token).digest('hex');
    assert.ok((await a.repository.findAccessTokenByHash(hashed))?.revoked_at);
    const metadata = await fetch(second.url + '/.well-known/oauth-authorization-server');
    assert.equal(metadata.status, 200);
    const doc = (await metadata.json()) as { token_endpoint: string };
    assert.equal(doc.token_endpoint, 'https://preview.example.invalid/oauth/token');

    // A password/session rotation must invalidate the signed session cookie
    // even when a second instance still holds that session in shared storage.
    await b.adapter.execute(
      "UPDATE users SET session_version=session_version+1 WHERE id='preview-owner'",
    );
    const staleSession = await fetch(`${first.url}/oauth/authorize?${args}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(staleSession.status, 302);
    assert.equal(staleSession.headers.get('location'), '/login');
  } finally {
    await Promise.all(servers.map(closeServer));
    await a?.close();
    await b?.close();
    await adapter.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
