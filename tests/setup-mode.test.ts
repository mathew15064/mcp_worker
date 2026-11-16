import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { runMigrations } from '../src/db/migrations';
import authService from '../src/services/authService';
import databaseManager from '../src/db/databaseManager';
import runtimeSettings from '../src/services/runtimeSettingsService';
import app from '../src/app';
import { workerDistributionBlocked } from '../src/services/workerReleaseGate';
import helper from './helper';
const { setupEnv, cleanup } = helper;

const env = setupEnv('setup-mode');
databaseManager.resetForTests();
runtimeSettings.resetForTests();

let server: Server;
let baseUrl: string;

function csrf(html: string) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
}

async function login() {
  const page = await fetch(`${baseUrl}/login`);
  const initialCookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = csrf(await page.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: initialCookie },
    body: new URLSearchParams({
      _csrf: token,
      username: 'admin',
      password: 'TestAdminPassword2026!',
      returnTo: '/admin',
    }).toString(),
  });
  assert.equal(response.status, 302);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

test.before(async () => {
  await databaseManager.initialize();
  await runtimeSettings.load(null);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanup(env.dir);
});

void test('fresh SQLite install remains administrable but blocks data until explicit initialization', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as { database: string };
  assert.equal(healthBody.database, 'UNCONFIGURED');

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 503);
  assert.equal(((await ready.json()) as { ready: boolean }).ready, false);

  const denied = await fetch(baseUrl + '/admin/onboarding', { redirect: 'manual' });
  assert.equal(denied.status, 302);
  const cookie = await login();
  const onboarding = await fetch(baseUrl + '/admin/onboarding', { headers: { cookie } });
  assert.equal(onboarding.status, 200);
  assert.equal(onboarding.headers.get('cache-control'), 'no-store');
  const guide = await onboarding.text();
  if (workerDistributionBlocked()) {
    assert.match(guide, /data-onboarding-status="blocked"/);
    assert.match(guide, /Blocked: signed Worker release not approved/);
  } else {
    // Historical source fixture while T1's fail-closed gate is on another
    // isolated branch; the integrated source must take the blocked path.
    assert.match(guide, /Next step: 2/);
  }
  assert.match(guide, /UNCONFIGURED/);
  assert.match(guide, /data-onboarding-step="2" data-complete="false"/);
  assert.doesNotMatch(guide, /br_sec_|br_enroll_/);
  const settings = await fetch(`${baseUrl}/admin/settings`, { headers: { cookie } });
  assert.equal(settings.status, 200);
  const settingsHtml = await settings.text();
  assert.match(settingsHtml, /SQLite is unavailable/);
  assert.doesNotMatch(settingsHtml, /Save Connection|Test Connection|MySQL host/);
  assert.doesNotMatch(settingsHtml, />Initialize Source<\/button>/);
  const runtime = await fetch(`${baseUrl}/admin/settings/runtime`, { headers: { cookie } });
  assert.equal(runtime.status, 200);
  assert.match(await runtime.text(), /ADMIN_USERNAME/);

  const clients = await fetch(`${baseUrl}/admin/clients`, { headers: { cookie } });
  assert.equal(clients.status, 503);
  assert.match(await clients.text(), /Database setup required/);

  const mcp = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(mcp.status, 503);
});

void test('existing compatible SQLite data is activated without erasing users or accepting legacy administrator password', async () => {
  const legacy = new Database(process.env.DATABASE_PATH);
  runMigrations(legacy);
  const now = new Date().toISOString();
  legacy
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, session_version, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', 1, ?, ?)`,
    )
    .run(crypto.randomUUID(), 'admin', bcrypt.hashSync('LegacyAdminPassword2026!', 10), now, now);
  legacy.close();

  databaseManager.resetForTests();
  const status = await databaseManager.initialize();
  assert.equal(status.state, 'READY');
  assert.equal(status.engine, 'sqlite');
  assert.equal(status.databaseExists, true);
  assert.equal(status.operational, true);
  assert.equal(status.setupOnly, false);
  assert.equal(databaseManager.getAdapter()?.kind, 'sqlite');

  const envAuth = await authService.authenticate('admin', 'TestAdminPassword2026!');
  assert.equal(envAuth.success, true);
  assert.equal(envAuth.user?.auth_source, 'env');
  const legacyAuth = await authService.authenticate('admin', 'LegacyAdminPassword2026!');
  assert.equal(legacyAuth.success, false);
});

void test('obsolete bootstrap configuration refuses implicit reuse without touching SQLite data', async () => {
  const legacy = process.env.BOOTSTRAP_CONFIG_PATH || '';
  fs.writeFileSync(legacy, 'obsolete development database config', { mode: 0o600 });
  const before = crypto.createHash('sha256').update(fs.readFileSync(env.dbPath)).digest('hex');
  databaseManager.resetForTests();
  await assert.rejects(() => databaseManager.initialize(), /Obsolete database bootstrap detected/);
  const after = crypto.createHash('sha256').update(fs.readFileSync(env.dbPath)).digest('hex');
  assert.equal(after, before);
  fs.unlinkSync(legacy);
});
