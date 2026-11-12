import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from 'node:child_process';

const enabled =
  Boolean(process.env.MYSQL_TEST_HOST) && process.env.BOT_REPORT_ISOLATED_WORKER_TEST === '1';

async function mysqlAdmin(database: string) {
  const mysql = require('mysql2/promise');
  return mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USERNAME || 'root',
    password: process.env.MYSQL_TEST_PASSWORD || '',
    database,
  });
}

async function waitFor<T>(
  check: () => Promise<T> | T,
  timeoutMs = 12_000,
): Promise<NonNullable<T>> {
  const started = Date.now();
  let lastError: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (lastError) throw lastError;
  throw new Error('Timed out waiting for worker integration state.');
}

function runCommand(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({ status: Number.isInteger(code) ? Number(code) : 1, stdout, stderr }),
    );
  });
}

void test(
  'real outbound worker executes MCP workspace, file and persistent direct-shell operations without SSH or tmux',
  { skip: !enabled },
  async (t) => {
    assert.ok(
      fs.existsSync('/.dockerenv'),
      'Worker installer test must run inside a disposable Docker container',
    );
    const database = 'bot_report_worker_live_test';
    const rootDatabase = process.env.MYSQL_TEST_DATABASE || 'bot_report_test';
    const admin = await mysqlAdmin(rootDatabase);
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await admin.end();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-report-worker-live-'));
    const workRoot = path.join(dir, 'workspace');
    fs.mkdirSync(workRoot, { recursive: true });
    const appKey = crypto.createHash('sha256').update('worker-live-app-key').digest('base64');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      DATABASE_PATH: path.join(dir, 'missing.sqlite'),
      BOOTSTRAP_CONFIG_PATH: path.join(dir, 'bootstrap-config.json'),
      SESSION_SECRET: 'worker-live-session-secret-that-is-long-enough-2026',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'WorkerLiveAdmin2026!',
      APP_ENCRYPTION_KEY: appKey,
      TERMINAL_CREDENTIAL_KEY: appKey,
      MCP_PUBLIC_BASE_URL: 'http://127.0.0.1:3333',
      MCP_ENABLED: 'true',
      LOGIN_RATE_LIMIT_MAX: '1000',
    });

    const bootstrapStore = require('../src/db/bootstrapConfigStore');
    bootstrapStore.save({
      host: process.env.MYSQL_TEST_HOST,
      port: Number(process.env.MYSQL_TEST_PORT || 3306),
      database,
      username: process.env.MYSQL_TEST_USERNAME || 'root',
      password: process.env.MYSQL_TEST_PASSWORD || '',
      ssl: false,
    });
    const databaseManager = require('../src/db/databaseManager');
    const runtimeSettings = require('../src/services/runtimeSettingsService');
    databaseManager.resetForTests();
    runtimeSettings.resetForTests();
    await databaseManager.initialize();
    assert.equal(databaseManager.status().state, 'CONFIGURED');
    const preparedSource = await databaseManager.prepareSourceInitialization();
    await runtimeSettings.seedDefaults(preparedSource.adapter);
    await databaseManager.activatePrepared(preparedSource);
    assert.equal(databaseManager.status().state, 'READY');

    const app = require('../src/app');
    const workerRepo = require('../src/repositories/workerRepository');
    const workerBroker = require('../src/services/workerConnectionBroker');
    const terminalMcpService = require('../src/services/terminalMcpService');
    const server = http.createServer(app);
    workerBroker.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;

    const userHome = path.join(dir, 'worker-user');
    fs.mkdirSync(userHome, { recursive: true });
    const workerHome = path.join(userHome, '.bot-report-worker');
    const statePath = path.join(workerHome, 'state.json');
    const cliPath = path.join(userHome, '.local', 'bin', 'bot-report-worker');
    const cliEnv = {
      ...process.env,
      HOME: userHome,
      BOT_REPORT_WORKER_HOME: workerHome,
      BOT_REPORT_WORKER_SKIP_SERVICE: '1',
      BOT_REPORT_WORKER_INSTALL_ROOT: path.join(userHome, '.local', 'share', 'bot-report-worker'),
      BOT_REPORT_WORKER_BIN_DIR: path.join(userHome, '.local', 'bin'),
      PATH: `${path.join(userHome, '.local', 'bin')}:${process.env.PATH}`,
    };
    t.after(async () => {
      try {
        spawnSync(cliPath, ['stop'], { cwd: workRoot, env: cliEnv, encoding: 'utf8' });
      } catch (_) {}
      try {
        workerBroker.close();
      } catch (_) {}
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } catch (_) {}
      try {
        await databaseManager.close();
      } catch (_) {}
      try {
        const cleanup = await mysqlAdmin(rootDatabase);
        await cleanup.query(`DROP DATABASE IF EXISTS \`${database}\``);
        await cleanup.end();
      } catch (_) {}
      fs.rmSync(dir, { recursive: true, force: true });
    });

    await runtimeSettings.set('mcp.public_base_url', baseUrl);
    const loginPage = await fetch(baseUrl + '/login');
    const initialCookie = (loginPage.headers.get('set-cookie') || '').split(';')[0];
    const csrf = (html: string) => html.match(/name="_csrf" value="([^"]+)"/)?.[1] || '';
    const signedIn = await fetch(baseUrl + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: initialCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: csrf(await loginPage.text()),
        username: 'admin',
        password: process.env.ADMIN_PASSWORD || '',
      }),
    });
    assert.equal(signedIn.status, 302);
    const cookie = (signedIn.headers.get('set-cookie') || '').split(';')[0];
    async function getPage(url: string) {
      const r = await fetch(baseUrl + url, { headers: { cookie } });
      assert.equal(r.status, 200);
      return r.text();
    }
    async function submit(url: string, fields: Record<string, string>) {
      return fetch(baseUrl + url, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
      });
    }
    const initialGuide = await getPage('/admin/onboarding');
    assert.match(initialGuide, /Next step: 4/);
    assert.match(initialGuide, /data-onboarding-step="2" data-complete="true"/);
    assert.match(initialGuide, /Loopback HTTP/);
    assert.doesNotMatch(initialGuide, /br_sec_|br_enroll_/);

    await runtimeSettings.set('mcp.enabled', 'false');
    assert.match(await getPage('/admin/onboarding'), /Next step: 3/);
    await runtimeSettings.set('mcp.enabled', 'true');
    const workersHtml = await getPage('/admin/workers');
    assert.equal(
      (await submit('/admin/workers/enrollment', { _csrf: csrf(workersHtml), ttl_seconds: '600' }))
        .status,
      302,
    );
    const enrollmentPage = await getPage('/admin/workers');
    const enrollment = {
      token: enrollmentPage.match(/id="worker-enrollment-token"[^>]*>([^<]+)/)?.[1] || '',
    };
    assert.doesNotMatch(await getPage('/admin/workers'), /id="worker-enrollment-token"/);

    // E2E starts a trusted, locally compiled Go test fixture in disposable Docker.
    // Public unsigned download is forbidden; the dedicated signed-release suite
    // verifies the cryptographic installer on each native runner.
    const installRoot = cliEnv.BOT_REPORT_WORKER_INSTALL_ROOT;
    const currentDir = path.join(installRoot, 'current');
    const currentBinary = path.join(currentDir, 'systemtd');
    fs.mkdirSync(currentDir, { recursive: true });
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.mkdirSync(workerHome, { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '../worker/bin/bot-report-worker-linux-amd64'),
      currentBinary,
    );
    fs.chmodSync(currentBinary, 0o755);
    fs.symlinkSync(currentBinary, cliPath);
    fs.symlinkSync(currentBinary, path.join(path.dirname(cliPath), 'systemtd'));
    fs.writeFileSync(path.join(workerHome, 'default-server'), baseUrl + '\n');
    fs.writeFileSync(path.join(workerHome, 'install-root'), installRoot + '\n');
    fs.writeFileSync(
      path.join(workerHome, 'bin-path'),
      path.join(path.dirname(cliPath), 'systemtd') + '\n',
    );
    assert.equal(fs.existsSync(cliPath), true, 'isolated test runtime must be executable');

    const loginResult = await runCommand(
      cliPath,
      [
        'login',
        '--token',
        enrollment.token,
        '--roots',
        workRoot,
        '--name',
        'Live Worker',
        '--profile',
        'Live Worker Profile',
        '--allow-shell',
        '--insecure-http',
      ],
      {
        cwd: workRoot,
        env: cliEnv,
      },
    );
    const childOutput = `${loginResult.stdout || ''}${loginResult.stderr || ''}`;
    assert.equal(loginResult.status, 0, childOutput);
    assert.match(childOutput, /execution profile=Live Worker Profile/);
    assert.match(childOutput, /connected profile=Live Worker Profile/);

    const worker = await waitFor(async () => {
      const row = await workerRepo.findWorkerByName('Live Worker');
      return row?.status === 'online' && workerBroker.isOnline(row.id) ? row : null;
    }).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nworker output:\n${childOutput}`,
      );
    });
    assert.ok(fs.existsSync(statePath));
    const stateText = fs.readFileSync(statePath, 'utf8');
    const configText = fs.readFileSync(path.join(workerHome, 'config.json'), 'utf8');
    const enrollmentTokenPattern = new RegExp(
      enrollment.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    assert.doesNotMatch(stateText, enrollmentTokenPattern);
    assert.doesNotMatch(configText, enrollmentTokenPattern);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(workerHome, 'config.json')).mode & 0o777, 0o600);
    }

    const autoProfile = await workerRepo.findProfileByName('Live Worker Profile');
    assert.equal(autoProfile.worker_id, worker.id);
    assert.equal(autoProfile.tmux_session, '');

    const exec = await terminalMcpService.workspaceExec('Live Worker Profile', 'printf worker-ok', {
      cwd: workRoot,
      timeoutMs: 5000,
    });
    assert.equal(exec.exit_code, 0);
    assert.equal(exec.stdout, 'worker-ok');

    const filePath = path.join(workRoot, 'worker.txt');
    const written = await terminalMcpService.fileWrite(
      'Live Worker Profile',
      filePath,
      'outbound-worker-file\n',
      { createDirs: false },
    );
    assert.equal(written.path, filePath);
    const read = await terminalMcpService.fileRead('Live Worker Profile', filePath);
    assert.equal(read.text, 'outbound-worker-file\n');

    const status = await terminalMcpService.status('Live Worker Profile');
    assert.equal(status.status, 'READY');
    assert.equal(status.pane_count, 1);
    await terminalMcpService.send('Live Worker Profile', 'printf "direct-shell-worker-ok\\n"', {
      submit: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const terminal = await terminalMcpService.read('Live Worker Profile', 30);
    assert.match(terminal.text, /direct-shell-worker-ok/);

    assert.match(await getPage('/admin/onboarding'), /Next step: 5/);
    const clientsHtml = await getPage('/admin/clients?first_call=local');
    assert.match(clientsHtml, /http:\/\/127\.0\.0\.1:43871\/callback/);
    assert.doesNotMatch(clientsHtml, /value="bot_report.terminal" checked/);
    assert.doesNotMatch(clientsHtml, /value="offline_access" checked/);
    const created = await submit('/admin/clients', {
      _csrf: csrf(clientsHtml),
      display_name: 'First read-only client',
      redirect_uris: 'http://127.0.0.1:43871/callback',
      scopes: 'bot_report.read',
    });
    assert.equal(created.status, 302);
    const oneTime = await getPage('/admin/clients');
    const firstId = oneTime.match(/id="new-client-id"[^>]*>([^<]+)/)?.[1] || '';
    const firstSecret = oneTime.match(/id="new-client-secret"[^>]*>([^<]+)/)?.[1] || '';
    assert.doesNotMatch(await getPage('/admin/clients'), /id="new-client-secret"/);
    assert.match(await getPage('/admin/onboarding'), /Next step: 6/);
    const first = spawn(
      process.execPath,
      [path.resolve(__dirname, '../scripts/first-mcp-call.js'), baseUrl],
      {
        env: {
          ...process.env,
          BOT_REPORT_FIRST_CLIENT_ID: firstId,
          BOT_REPORT_FIRST_CLIENT_SECRET: firstSecret,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let firstOutput = '';
    first.stdout.on('data', (chunk) => {
      firstOutput += chunk;
    });
    first.stderr.on('data', (chunk) => {
      firstOutput += chunk;
    });
    const finished = new Promise<number | null>((resolve, reject) => {
      first.once('error', reject);
      first.once('close', resolve);
    });
    t.after(() => {
      if (first.exitCode === null) first.kill();
    });
    const authUrl = await waitFor(
      () => firstOutput.match(/http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+/)?.[0],
    );
    const authParams = Object.fromEntries(new URL(authUrl).searchParams);
    const consent = await fetch(authUrl, { headers: { cookie } });
    assert.equal(consent.status, 200);
    const approved = await submit('/oauth/authorize', {
      ...authParams,
      _csrf: csrf(await consent.text()),
      action: 'allow',
    });
    assert.equal(approved.status, 302);
    const callback = approved.headers.get('location');
    const wrong = new URL(callback || '');
    wrong.searchParams.set('state', 'invalid');
    assert.equal((await fetch(wrong)).status, 400);
    assert.equal((await fetch(callback || '')).status, 200);
    assert.equal(await finished, 0, 'first-call helper failed');
    assert.match(firstOutput, /PASS runtime_info/);
    assert.ok(!firstOutput.includes(firstSecret));
    await waitFor(async () =>
      (await getPage('/admin/onboarding')).includes('All six steps complete'),
    );
    console.log(
      'ONBOARDING PASS: admin login, live Worker, one-time client secret, browser consent, PKCE callback, first MCP call, audit progress',
    );

    // Exercise the actual authenticated HTTP MCP transport against the live Worker.
    const { issueToken, parseMcpResponse } = require('./helper');
    const { token } = await issueToken();
    let requestId = 0;
    const called = new Set();
    interface RpcResult {
      tools?: { name: string }[];
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type: string; text: string }>;
    }
    async function rpc(method: string, params: Record<string, unknown>): Promise<RpcResult> {
      const response = await fetch(baseUrl + '/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer ' + token.access_token,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      });
      assert.equal(response.status, 200);
      const body = await parseMcpResponse(response);
      assert.ok(!body.error, JSON.stringify(body.error));
      assert.ok(!body.result?.isError, JSON.stringify(body.result));
      if (!body.result) throw new Error('MCP response missing result');
      return body.result as RpcResult;
    }
    const catalog = (await rpc('tools/list', {})).tools || [];
    assert.equal(catalog.length, 15);
    const profile = 'Live Worker Profile';
    async function call(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
      const result = await rpc('tools/call', { name, arguments: args });
      called.add(name);
      console.log('MCP PASS ' + name);
      return (
        result.structuredContent ||
        (JSON.parse(result.content?.[0]?.text || '{}') as Record<string, unknown>)
      );
    }
    const runtime = await call('runtime_info');
    assert.equal(runtime.tool_count, 15);
    assert.equal(
      runtime.tool_schema_hash,
      'a79786ed09ba2e8eef30ec778453b17c81963bf943542c1f2ea0f87952e4a032',
    );
    await call('terminal_list');
    assert.equal(
      (
        await call('workspace_exec', {
          profile,
          cwd: workRoot,
          command:
            'git init -q && git add worker.txt && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm initial',
        })
      ).exit_code,
      0,
    );
    const readMcp = await call('file_read', { profile, path: filePath });
    assert.equal(readMcp.text, 'outbound-worker-file\n');
    await call('file_patch', {
      profile,
      path: filePath,
      old_text: 'outbound-worker-file',
      new_text: 'mcp-patched',
      expected_sha256: readMcp.sha256,
    });
    await call('file_write', {
      profile,
      path: path.join(workRoot, 'new.txt'),
      content: 'mcp-created\n',
    });
    const snapshot = await call('repo_snapshot', { profile, repo: workRoot });
    assert.equal(snapshot.dirty, true);
    const diff = await call('git_diff', { profile, repo: workRoot });
    assert.match(JSON.stringify(diff), /mcp-patched/);
    const search = await call('code_search', { profile, cwd: workRoot, query: 'mcp-patched' });
    assert.match(JSON.stringify(search), /worker.txt/);
    const artifact = await call('artifact_collect', { profile, path: filePath });
    assert.match(JSON.stringify(artifact), /mcp-patched/);
    assert.equal(
      (await call('check_run', { profile, cwd: workRoot, command: 'test -f new.txt' })).exit_code,
      0,
    );
    const proc = await call('process_start', {
      profile,
      cwd: workRoot,
      command: 'echo mcp-live-process; sleep 60',
    });
    const process_id = String(proc.process_id);
    assert.match(process_id, /^brproc-/);
    await call('process_status', { profile, process_id });
    await waitFor(async () =>
      JSON.stringify(await call('process_logs', { profile, process_id })).includes(
        'mcp-live-process',
      ),
    );
    await call('process_stop', { profile, process_id });
    assert.deepEqual([...called].sort(), catalog.map((tool) => tool.name).sort());

    assert.match(
      spawnSync(cliPath, ['status'], { cwd: workRoot, env: cliEnv, encoding: 'utf8' }).stdout,
      /status: RUNNING/,
    );

    // Even with a running, enrolled Worker, the unapproved public installer
    // must refuse installation and leave binary, identity and config intact.
    const identityBefore = fs.readFileSync(statePath);
    const configBefore = fs.readFileSync(path.join(workerHome, 'config.json'));
    const binaryBefore = fs.readFileSync(currentBinary);
    const scriptPath = path.join(dir, 'unapproved-public-install.sh');
    const download = await runCommand(
      'curl',
      ['-fsSL', baseUrl + '/worker/install.sh', '-o', scriptPath],
      { cwd: workRoot, env: cliEnv },
    );
    assert.equal(download.status, 0, download.stderr);
    const blocked = await runCommand('sh', [scriptPath], { cwd: workRoot, env: cliEnv });
    assert.notEqual(blocked.status, 0, 'unapproved installer changed running Worker');
    assert.match(blocked.stderr, /signed release not approved/i);
    assert.deepEqual(fs.readFileSync(currentBinary), binaryBefore);
    assert.deepEqual(fs.readFileSync(statePath), identityBefore);
    assert.deepEqual(fs.readFileSync(path.join(workerHome, 'config.json')), configBefore);
    assert.ok(workerBroker.isOnline(worker.id));
    console.log('LIFECYCLE PASS: pending public installer cannot mutate live identity, config or binary');

    const uninstallResult = await runCommand(cliPath, ['uninstall'], {
      cwd: workRoot,
      env: cliEnv,
    });
    assert.equal(uninstallResult.status, 0, `${uninstallResult.stdout}${uninstallResult.stderr}`);
    assert.match(uninstallResult.stdout, /uninstalled local_state=removed installation=removed/);
    assert.equal(fs.existsSync(workerHome), false);
    assert.equal(fs.existsSync(path.join(userHome, '.local', 'share', 'bot-report-worker')), false);
    assert.equal(fs.existsSync(cliPath), false);
  },
);
