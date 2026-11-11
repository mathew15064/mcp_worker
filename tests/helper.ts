import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type DatabaseManager from '../src/db/databaseManager';
import type RuntimeSettings from '../src/services/runtimeSettingsService';
import type * as DbConnection from '../src/db/connection';
import type * as DbMigrations from '../src/db/migrations';

function setupEnv(prefix: string = 'bot_report_mcp_test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}_`));
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
  process.env.BOOTSTRAP_CONFIG_PATH = path.join(dir, 'bootstrap-config.json');
  process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-123456';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'TestAdminPassword2026!';
  const applicationKey = crypto.createHash('sha256').update('terminal-test-key').digest('base64');
  process.env.APP_ENCRYPTION_KEY = applicationKey;
  process.env.TERMINAL_CREDENTIAL_KEY = applicationKey;
  process.env.TELEGRAM_CREDENTIAL_KEY = crypto
    .createHash('sha256')
    .update('telegram-test-key')
    .digest('base64');
  process.env.MCP_ENABLED = 'true';
  process.env.MCP_PUBLIC_BASE_URL = 'http://127.0.0.1:3333';
  process.env.MCP_RESOURCE_URL = 'http://127.0.0.1:3333/mcp';
  process.env.MCP_ALLOW_TEST_FIXTURES = 'true';
  return { dir, dbPath: process.env.DATABASE_PATH };
}

function cleanup(dir: string) {
  try {
    (require('../src/db/databaseManager') as typeof DatabaseManager).resetForTests();
  } catch {}
  try {
    (require('../src/services/runtimeSettingsService') as typeof RuntimeSettings).resetForTests();
  } catch {}
  try {
    (require('../src/db/connection') as typeof DbConnection).closeDb();
  } catch {}
  for (const name of ['BOOTSTRAP_CONFIG_PATH', 'APP_ENCRYPTION_KEY']) delete process.env[name];
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function initDb() {
  const { runMigrations } = require('../src/db/migrations') as typeof DbMigrations;
  const { getDb } = require('../src/db/connection') as typeof DbConnection;
  const databaseManager = require('../src/db/databaseManager') as typeof DatabaseManager;
  runMigrations();
  databaseManager.useLegacyForTests(getDb());
}

function pkce(verifier: string) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function issueToken({
  principalId = 'principal:gpt_client',
  scopes = ['bot_report.read', 'bot_report.terminal', 'offline_access'],
}: { principalId?: string; scopes?: string[] } = {}) {
  const { default: service } = await import('../src/services/mcpOAuthService.js');
  const { default: config } = await import('../src/config/mcpConfig.js');
  const verifier = 'mcp-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const registered = await service.registerClient({
    displayName: 'MCP Test Client',
    principalId,
    redirectUris: [redirectUri],
    allowedScopes: scopes,
  });
  if (!registered.client) throw new Error('OAuth client fixture missing');
  const code = await service.issueAuthorizationCode({
    clientId: registered.client.client_id,
    userId: 'env-admin',
    principalId,
    redirectUri,
    resource: config.resourceUrl,
    scopes,
    codeChallenge: pkce(verifier),
    codeChallengeMethod: 'S256',
  });
  const token = await service.exchangeAuthorizationCode({
    clientId: registered.client.client_id,
    clientSecret: registered.rawSecret,
    code,
    redirectUri,
    resource: config.resourceUrl,
    codeVerifier: verifier,
  });
  return { ...registered, client: registered.client, token, verifier, redirectUri };
}

async function parseMcpResponse(response: Response): Promise<{
  result?: {
    tools?: Array<{ name: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: unknown;
}> {
  const text = await response.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}

export = { setupEnv, cleanup, initDb, issueToken, pkce, parseMcpResponse };
