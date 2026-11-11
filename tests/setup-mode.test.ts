import test from 'node:test';
import assert from 'node:assert/strict';
import http, {type Server} from 'node:http';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import {runMigrations} from '../src/db/migrations';
import authService = require('../src/services/authService');
import store = require('../src/db/bootstrapConfigStore');
import databaseManager = require('../src/db/databaseManager');
import runtimeSettings = require('../src/services/runtimeSettingsService');
import app = require('../src/app');
import helper = require('./helper');
const {setupEnv,cleanup} = helper;

const env = setupEnv('setup-mode');
databaseManager.resetForTests();
runtimeSettings.resetForTests();

let server: Server;
let baseUrl: string;

function csrf(html: string) { return html.match(/name="_csrf" value="([^"]+)"/)?.[1] || ''; }

async function login() {
  const page = await fetch(`${baseUrl}/login`);
  const initialCookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = csrf(await page.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: initialCookie },
    body: new URLSearchParams({ _csrf: token, username: 'admin', password: 'TestAdminPassword2026!', returnTo: '/admin' }).toString()
  });
  assert.equal(response.status, 302);
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

test.before(async () => {
  await databaseManager.initialize();
  await runtimeSettings.load(null);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});

test.after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  cleanup(env.dir);
});

test('fresh install stays administrable without a database and blocks data surfaces until MySQL is configured', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal((healthBody as {database:string}).database, 'UNCONFIGURED');

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 503);
  assert.equal(((await ready.json()) as {ready:boolean}).ready, false);

  const denied = await fetch(baseUrl + '/admin/onboarding', { redirect: 'manual' });
  assert.equal(denied.status, 302);
  const cookie = await login();
  const onboarding = await fetch(baseUrl + '/admin/onboarding', { headers: { cookie } });
  assert.equal(onboarding.status, 200);
  assert.equal(onboarding.headers.get('cache-control'), 'no-store');
  const guide = await onboarding.text();
  assert.match(guide, /Next step: 2/);
  assert.match(guide, /UNCONFIGURED/);
  assert.match(guide, /data-onboarding-step="2" data-complete="false"/);
  assert.doesNotMatch(guide, /br_sec_|br_enroll_/);
  const settings = await fetch(`${baseUrl}/admin/settings`, { headers: { cookie } });
  assert.equal(settings.status, 200);
  const settingsHtml = await settings.text();
  assert.match(settingsHtml, /No MySQL connection has been configured yet/);
  assert.match(settingsHtml, /Save Connection/);
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
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(mcp.status, 503);
});

test('existing SQLite data becomes migration-only and keeps a temporary legacy-admin login bridge', async () => {
  const legacy = new Database(process.env.DATABASE_PATH);
  runMigrations(legacy);
  const now = new Date().toISOString();
  legacy.prepare(`INSERT INTO users (id, username, password_hash, role, session_version, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', 1, ?, ?)`).run(
    crypto.randomUUID(), 'admin', bcrypt.hashSync('LegacyAdminPassword2026!', 10), now, now
  );
  legacy.close();

  databaseManager.resetForTests();
  const status = await databaseManager.initialize();
  assert.equal(status.state, 'MIGRATION_REQUIRED');
  assert.equal(status.legacyAvailable, true);
  assert.equal(status.operational, false);
  assert.equal(status.setupOnly, true);
  assert.equal(databaseManager.getAdapter(), null);

  const envAuth = await authService.authenticate('admin', 'TestAdminPassword2026!');
  assert.equal(envAuth.success, true);
  assert.equal(envAuth.user?.auth_source, 'env');
  const legacyAuth = await authService.authenticate('admin', 'LegacyAdminPassword2026!');
  assert.equal(legacyAuth.success, true);
  assert.equal(legacyAuth.user?.auth_source, 'legacy');
});

test('bootstrap MySQL password is encrypted on disk and never returned by public config', () => {
  const password = 'mysql-super-secret-password';
  const publicConfig = store.save({ host: 'db.internal', port: 3306, database: 'bot_report', username: 'bot_report', password, ssl: true });
  const raw = fs.readFileSync(store.path, 'utf8');
  assert.doesNotMatch(raw, new RegExp(password));
  assert.match(raw, /password_envelope/);
  if (!publicConfig) throw new Error('Public bootstrap config missing');
  assert.equal(publicConfig.hasPassword, true);
  assert.equal('password' in publicConfig, false);
  assert.equal(store.load()?.password, password);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
});
