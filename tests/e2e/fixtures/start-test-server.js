const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-report-playwright-'));
const databasePath = path.join(dir, 'playwright.sqlite');
const applicationKey = crypto.createHash('sha256').update('playwright-terminal-key').digest('base64');

Object.assign(process.env, {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3399',
  DATABASE_PATH: databasePath,
  BOOTSTRAP_CONFIG_PATH: path.join(dir, 'bootstrap-config.json'),
  SESSION_SECRET: 'playwright-session-secret-that-is-long-enough-2026',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'PlaywrightAdmin2026!',
  APP_ENCRYPTION_KEY: applicationKey,
  TERMINAL_CREDENTIAL_KEY: applicationKey,
  TELEGRAM_CREDENTIAL_KEY: crypto.createHash('sha256').update('playwright-telegram-key').digest('base64'),
  MCP_ENABLED: 'true',
  MCP_PUBLIC_BASE_URL: 'http://127.0.0.1:3399',
  MCP_RESOURCE_URL: 'http://127.0.0.1:3399/mcp',
  MCP_ALLOW_TEST_FIXTURES: 'true',
  LOGIN_RATE_LIMIT_MAX: '1000'
});

process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

async function main() {
  const { runMigrations } = require('../../../src/db/migrations');
  const { getDb } = require('../../../src/db/connection');
  const databaseManager = require('../../../src/db/databaseManager');
  const runtimeSettings = require('../../../src/services/runtimeSettingsService');
  runMigrations();
  databaseManager.useLegacyForTests(getDb());
  await runtimeSettings.load(databaseManager.getAdapter());

  const oauthService = require('../../../src/services/mcpOAuthService');
  const oauthRepo = require('../../../src/repositories/mcpOAuthRepository');
  const workerRepo = require('../../../src/repositories/workerRepository');
  const workerBroker = require('../../../src/services/workerConnectionBroker');
  const telegramSecrets = require('../../../src/services/telegramSecretService');

  for (const [index, name] of ['ChatGPT Connector', 'Local QA Client', 'Automation Client'].entries()) {
    await oauthService.registerClient({
      displayName: name,
      principalId: `principal:playwright-${index + 1}`,
      redirectUris: [`http://localhost:${4400 + index}/oauth/callback`],
      allowedScopes: ['bot_report.read', 'bot_report.terminal', 'offline_access']
    });
  }

  const auditClient = (await oauthRepo.listClients()).find(client => client.display_name === 'ChatGPT Connector');
  await oauthRepo.recordAudit({
    id: 'aud_playwright_runtime_info', requestId: 'req_playwright_runtime_info', clientId: auditClient.client_id, principalId: auditClient.principal_id,
    mcpMethod: 'tools/call', toolName: 'runtime_info', result: 'SUCCESS', httpStatus: 200, durationMs: 18,
    requestPayload: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'runtime_info', arguments: { profile: 'Codex' } } }),
    responsePayload: JSON.stringify({ jsonrpc: '2.0', id: 11, result: { content: [{ type: 'text', text: 'runtime ready' }] } })
  });
  await oauthRepo.recordAudit({
    requestId: 'req_playwright_terminal_list', clientId: auditClient.client_id, principalId: auditClient.principal_id,
    mcpMethod: 'tools/call', toolName: 'terminal_list', result: 'ERROR', httpStatus: 500, durationMs: 42
  });
  for (let index = 0; index < 25; index += 1) {
    await oauthRepo.recordAudit({
      requestId: `req_playwright_page_${String(index).padStart(2, '0')}`, clientId: auditClient.client_id,
      principalId: auditClient.principal_id, mcpMethod: 'tools/call', toolName: 'repo_snapshot',
      result: 'SUCCESS', httpStatus: 200, durationMs: 10 + index
    });
  }

  const workerKeyPair = crypto.generateKeyPairSync('ed25519');
  const worker = await workerRepo.createWorker({
    name: 'Playwright Worker',
    publicKey: workerKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    capabilities: ['tmux.inspect', 'tmux.send', 'tmux.read', 'tmux.interrupt', 'workspace.exec', 'artifact.collect', 'file.write']
  });
  await workerRepo.touchWorker(worker.id);
  const originalIsOnline = workerBroker.isOnline.bind(workerBroker);
  workerBroker.isOnline = workerId => workerId === worker.id || originalIsOnline(workerId);

  for (const [index, name] of ['Dev Alpha', 'Dev Beta', 'Ops Gamma', 'QA Delta'].entries()) {
    await workerRepo.createProfile({
      name, description: `${name} Playwright fixture`, worker_id: worker.id,
      tmux_session: `pw-${index + 1}`, enabled: index !== 2
    });
  }
  await workerRepo.createProfile({
    name: 'Worker Alpha', description: 'Outbound Playwright fixture', worker_id: worker.id,
    tmux_session: 'pw-worker', enabled: true
  });

  await runtimeSettings.set('telegram.enabled', 'false');
  await runtimeSettings.set('telegram.chat_id', '123456789');
  await runtimeSettings.set('telegram.bot_token', telegramSecrets.encrypt('123456:playwright-fixture-token'));

  const serverModule = require('../../../src/server');
  await serverModule.ready;
  console.log(`[PLAYWRIGHT] disposable server ready with DB ${databasePath}`);
}

main().catch(error => {
  console.error('[PLAYWRIGHT_BOOT_ERROR]', error);
  process.exit(1);
});
