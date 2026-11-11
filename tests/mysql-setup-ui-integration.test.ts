import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const enabled = Boolean(process.env.MYSQL_TEST_HOST);

function extractCsrf(html: string) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
}

async function adminConnection(database: string) {
  const mysql = require('mysql2/promise');
  return mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USERNAME || 'root',
    password: process.env.MYSQL_TEST_PASSWORD || '',
    database,
  });
}

void test(
  'fresh Admin UI separates save/test from explicit MySQL source initialization',
  { skip: !enabled },
  async (t) => {
    const database = 'bot_report_ui_test';
    const root = await adminConnection(process.env.MYSQL_TEST_DATABASE || 'bot_report_test');
    await root.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await root.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await root.end();
    t.after(async () => {
      try {
        const admin = await adminConnection(process.env.MYSQL_TEST_DATABASE || 'bot_report_test');
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        await admin.end();
      } catch (_) {}
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-report-mysql-ui-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const appKey = crypto.createHash('sha256').update('mysql-ui-integration-key').digest('base64');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      DATABASE_PATH: path.join(dir, 'missing-legacy.sqlite'),
      BOOTSTRAP_CONFIG_PATH: path.join(dir, 'bootstrap-config.json'),
      SESSION_SECRET: 'mysql-ui-session-secret-that-is-long-enough-2026',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'MysqlUiAdmin2026!',
      APP_ENCRYPTION_KEY: appKey,
      TERMINAL_CREDENTIAL_KEY: appKey,
      MCP_PUBLIC_BASE_URL: 'http://127.0.0.1:3333',
      MCP_ENABLED: 'true',
      LOGIN_RATE_LIMIT_MAX: '1000',
    });

    const databaseManager = require('../src/db/databaseManager');
    const runtimeSettings = require('../src/services/runtimeSettingsService');
    databaseManager.resetForTests();
    runtimeSettings.resetForTests();
    await databaseManager.initialize();
    await runtimeSettings.load(null);
    assert.equal(databaseManager.status().state, 'UNCONFIGURED');

    const app = require('../src/app');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await databaseManager.close();
    });
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;

    const loginPage = await fetch(`${base}/login`);
    const preCookie = (loginPage.headers.get('set-cookie') || '').split(';')[0];
    const loginCsrf = extractCsrf(await loginPage.text());
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: preCookie },
      body: new URLSearchParams({
        _csrf: loginCsrf,
        username: 'admin',
        password: 'MysqlUiAdmin2026!',
        returnTo: '/admin/settings',
      }).toString(),
    });
    assert.equal(login.status, 302);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const settingsBefore = await fetch(`${base}/admin/settings`, { headers: { cookie } });
    const settingsBeforeHtml = await settingsBefore.text();
    const csrf = extractCsrf(settingsBeforeHtml);
    assert.match(settingsBeforeHtml, /UNCONFIGURED/);
    assert.ok(csrf);

    const form = {
      _csrf: csrf,
      host: process.env.MYSQL_TEST_HOST || '127.0.0.1',
      port: String(process.env.MYSQL_TEST_PORT || 3306),
      database,
      username: process.env.MYSQL_TEST_USERNAME || 'root',
      password: process.env.MYSQL_TEST_PASSWORD || '',
      ssl: 'false',
    };
    const tested = await fetch(`${base}/admin/settings/database/test`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        cookie,
      },
      body: new URLSearchParams(form).toString(),
    });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).ok, true);
    assert.equal(databaseManager.status().state, 'UNCONFIGURED');

    const save = await fetch(`${base}/admin/settings/database/save`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams(form).toString(),
    });
    assert.equal(save.status, 302);
    assert.equal(save.headers.get('location'), '/admin/settings/database');
    assert.equal(databaseManager.status().state, 'CONFIGURED');
    assert.equal(databaseManager.status().engine, null);
    assert.equal(databaseManager.status().source?.initialized, false);

    const bootstrapRaw = fs.readFileSync(process.env.BOOTSTRAP_CONFIG_PATH || '', 'utf8');
    assert.doesNotMatch(bootstrapRaw, new RegExp(process.env.MYSQL_TEST_PASSWORD || ''));

    const untouched = await adminConnection(database);
    const [tablesBeforeInit] = await untouched.query('SHOW TABLES');
    await untouched.end();
    assert.equal(tablesBeforeInit.length, 0, 'Save Connection must not create schema tables');

    await databaseManager.close();
    databaseManager.resetForTests();
    runtimeSettings.resetForTests();
    await databaseManager.initialize();
    await runtimeSettings.load(databaseManager.getAdapter());
    assert.equal(
      databaseManager.status().state,
      'CONFIGURED',
      'Restart must not auto-initialize the saved MySQL source',
    );

    const settingsSaved = await fetch(`${base}/admin/settings/database`, { headers: { cookie } });
    const savedHtml = await settingsSaved.text();
    assert.match(savedHtml, />CONFIGURED</);
    assert.match(savedHtml, /Initialize Source/);
    assert.match(savedHtml, /Saving the connection never changes the MySQL schema/);

    const blockedClients = await fetch(`${base}/admin/clients`, { headers: { cookie } });
    assert.equal(blockedClients.status, 503);
    const notReady = await fetch(`${base}/readyz`);
    assert.equal(notReady.status, 503);
    assert.equal((await notReady.json()).database, 'CONFIGURED');

    const initialize = await fetch(`${base}/admin/settings/database/initialize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    assert.equal(initialize.status, 302);
    assert.equal(initialize.headers.get('location'), '/admin/settings/database');
    assert.equal(databaseManager.status().state, 'READY');
    assert.equal(databaseManager.status().engine, 'mysql');
    assert.equal(databaseManager.status().source?.initialized, true);

    const settingsAfter = await fetch(`${base}/admin/settings/database`, { headers: { cookie } });
    const afterHtml = await settingsAfter.text();
    assert.match(afterHtml, />READY</);
    assert.doesNotMatch(afterHtml, />Initialize Source<\/button>/);

    const enrollmentResponse = await fetch(`${base}/admin/workers/enrollment`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ _csrf: csrf, ttl_seconds: '600' }).toString(),
    });
    assert.equal(enrollmentResponse.status, 302);
    assert.equal(enrollmentResponse.headers.get('location'), '/admin/workers');
    const workersWithToken = await fetch(`${base}/admin/workers`, { headers: { cookie } });
    assert.equal(workersWithToken.status, 200);
    const workersHtml = await workersWithToken.text();
    const enrollmentToken = workersHtml.match(/br_enroll_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(enrollmentToken);
    assert.match(workersHtml, /Outbound execution agents/);

    const pair = crypto.generateKeyPairSync('ed25519');
    const enrolled = await fetch(`${base}/worker/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: enrollmentToken,
        name: 'MySQL UI Worker',
        public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        capabilities: ['tmux.inspect', 'workspace.exec'],
      }),
    });
    assert.equal(enrolled.status, 201);
    const enrolledBody = await enrolled.json();
    assert.ok(enrolledBody.worker_id);
    assert.deepEqual(enrolledBody.capabilities, ['tmux.inspect', 'workspace.exec']);

    const createProfile = () =>
      fetch(`${base}/admin/workers/profiles`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({
          _csrf: csrf,
          name: 'Worker UI Dev',
          description: 'worker integration profile',
          worker_id: enrolledBody.worker_id,
          tmux_session: 'main',
          enabled: 'true',
        }).toString(),
      });
    // Enrollment does not imply an active WSS connection. An offline Worker must be rejected.
    const offlineCreate = await createProfile();
    assert.equal(offlineCreate.status, 302);
    const offlinePage = await fetch(`${base}/admin/workers`, { headers: { cookie } });
    const offlineHtml = await offlinePage.text();
    assert.match(offlineHtml, /currently online/);
    assert.doesNotMatch(offlineHtml, /Worker UI Dev/);

    // Simulate only the broker's online status in this isolated HTTP fixture.
    // This test does not run an actual Worker; real WSS is covered by separate E2E.
    const workerBroker = require('../src/services/workerConnectionBroker');
    const fixtureSocket = { readyState: 1, close() {} };
    workerBroker.connections.set(enrolledBody.worker_id, fixtureSocket);
    t.after(() => {
      if (workerBroker.connections.get(enrolledBody.worker_id) === fixtureSocket) {
        workerBroker.connections.delete(enrolledBody.worker_id);
      }
    });
    const profileCreated = await createProfile();
    assert.equal(profileCreated.status, 302);
    assert.equal(profileCreated.headers.get('location'), '/admin/terminals');
    const terminalsAfter = await fetch(`${base}/admin/terminals`, { headers: { cookie } });
    const terminalsAfterHtml = await terminalsAfter.text();
    assert.match(terminalsAfterHtml, /Worker UI Dev/);
    const workersAfter = await fetch(`${base}/admin/workers`, { headers: { cookie } });
    const workersAfterHtml = await workersAfter.text();
    assert.match(workersAfterHtml, /MySQL UI Worker/);
    assert.doesNotMatch(workersAfterHtml, /br_enroll_[A-Za-z0-9_-]+/);

    const clients = await fetch(`${base}/admin/clients`, { headers: { cookie } });
    assert.equal(clients.status, 200);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).database, 'READY');
  },
);
