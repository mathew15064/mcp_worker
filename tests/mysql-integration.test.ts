import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const enabled = Boolean(process.env.MYSQL_TEST_HOST);

function mysqlConfig() {
  return {
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database: process.env.MYSQL_TEST_DATABASE || 'bot_report_test',
    username: process.env.MYSQL_TEST_USERNAME || 'root',
    password: process.env.MYSQL_TEST_PASSWORD || '',
    ssl: false,
    connectionLimit: 4,
  };
}

void test(
  'MySQL migrations, repositories, OAuth transactions, rollback and legacy import work end-to-end',
  { skip: !enabled },
  async (t) => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENCRYPTION_KEY ||= crypto
      .createHash('sha256')
      .update('mysql-integration-key')
      .digest('base64');
    process.env.TERMINAL_CREDENTIAL_KEY ||= process.env.APP_ENCRYPTION_KEY;
    process.env.MCP_PUBLIC_BASE_URL = 'http://127.0.0.1:3333';

    const { MysqlAdapter } = require('../src/db/adapters/mysqlAdapter');
    const { MigrationRunner } = require('../src/db/migrationRunner');
    const { SettingsRepository } = require('../src/repositories/settingsRepository');
    const { TerminalProfileRepository } = require('../src/repositories/terminalProfileRepository');
    const { WorkerRepository } = require('../src/repositories/workerRepository');
    const { WorkerAuthService } = require('../src/services/workerAuthService');
    const { McpOAuthRepository } = require('../src/repositories/mcpOAuthRepository');
    const { McpOAuthService } = require('../src/services/mcpOAuthService');
    const legacyImporter = require('../src/services/legacySqliteImportService');
    const Database = require('better-sqlite3');
    const { runMigrations: runLegacySchema } = require('../src/db/migrations');

    const adapter = MysqlAdapter.create(mysqlConfig());
    t.after(async () => {
      try {
        await new MigrationRunner(adapter).fresh({ allowDestructive: true });
      } catch (_) {}
      await adapter.close();
    });

    await adapter.ping();
    const info = await adapter.serverInfo();
    assert.match(String(info.version), /^8\./);

    const { migrationFiles } = require('../src/db/migrationRunner');
    const expectedCount = migrationFiles().length;
    const runner = new MigrationRunner(adapter);
    const fresh = await runner.fresh({ allowDestructive: true });
    assert.equal(fresh.ran.length, expectedCount);
    let status = await runner.status();
    assert.equal(status.length, expectedCount);
    assert.equal(
      status.every((row: { ran: boolean }) => row.ran),
      true,
    );
    assert.equal(new Set(status.map((row: { batch: number | null }) => row.batch)).size, 1);

    const rollback = await runner.rollback();
    assert.equal(rollback.rolledBack.length, expectedCount);
    assert.equal(rollback.rolledBack[0], '2026_11_02_000012_add_user_ownership_to_workers');
    assert.equal(rollback.rolledBack.at(-1), '2026_11_01_000001_create_system_settings_table');
    status = await runner.status();
    assert.equal(status.filter((row: { ran: boolean }) => !row.ran).length, expectedCount);
    const remigrate = await runner.migrate();
    assert.equal(remigrate.ran.length, expectedCount);

    const stepRollback = await runner.rollback({ steps: 2 });
    assert.deepEqual(stepRollback.rolledBack, [
      '2026_11_02_000012_add_user_ownership_to_workers',
      '2026_11_02_000011_add_payloads_to_mcp_request_audit',
    ]);
    status = await runner.status();
    assert.equal(status.filter((row: { ran: boolean }) => !row.ran).length, 2);
    const stepRemigrate = await runner.migrate();
    assert.equal(stepRemigrate.ran.length, 2);

    const workerRepo = new WorkerRepository(adapter);
    const workerAuth = new WorkerAuthService({ repository: workerRepo });
    const enrollment = await workerRepo.createEnrollmentToken({ ttlSeconds: 600 });
    const workerKeys = crypto.generateKeyPairSync('ed25519');
    const worker = await workerAuth.enroll({
      token: enrollment.token,
      name: 'Integration Worker',
      publicKey: workerKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      capabilities: ['workspace.exec', 'tmux.inspect', 'not.allowed'],
    });
    assert.equal(worker.name, 'Integration Worker');
    assert.equal(worker.enabled, true);
    assert.deepEqual(worker.capabilities, ['tmux.inspect', 'workspace.exec']);
    assert.equal((await workerRepo.setWorkerEnabled(worker.id, false)).enabled, false);
    assert.equal((await workerRepo.setWorkerEnabled(worker.id, true)).enabled, true);
    await assert.rejects(
      () =>
        workerAuth.enroll({
          token: enrollment.token,
          name: 'Replay Worker',
          publicKey: workerKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          capabilities: [],
        }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'WORKER_ENROLLMENT_INVALID',
    );
    const workerProfile = await workerRepo.createProfile({
      name: 'Worker Dev',
      description: 'outbound transport',
      workerId: worker.id,
      tmuxSession: 'main',
      enabled: true,
    });
    assert.equal(workerProfile.transport, 'worker');
    assert.equal(workerProfile.worker_name, 'Integration Worker');

    const settings = new SettingsRepository(adapter);
    await settings.set('mcp.enabled', 'true');
    assert.equal(await settings.get('mcp.enabled'), 'true');

    const terminals = new TerminalProfileRepository(adapter);
    const terminal = await terminals.create(
      {
        name: 'Mysql Dev',
        description: 'integration',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        tmux_session: 'mysql-dev',
        enabled: true,
      },
      'enc:test-envelope',
    );
    assert.equal((await terminals.findById(terminal.id)).name, 'Mysql Dev');
    await assert.rejects(
      () =>
        terminals.create(
          {
            name: 'mysql dev',
            description: '',
            host: '127.0.0.1',
            port: 22,
            username: 'root',
            tmux_session: 'other',
            enabled: true,
          },
          'enc:test-envelope',
        ),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'PROFILE_NAME_CONFLICT',
    );

    const oauthRepo = new McpOAuthRepository(adapter);
    const oauthConfig = {
      supportedScopes: ['bot_report.read', 'bot_report.terminal', 'offline_access'],
      resourceUrl: 'http://127.0.0.1:3333/mcp',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2592000,
      authCodeTtlSeconds: 300,
    };
    const oauth = new McpOAuthService(oauthRepo, oauthConfig);
    const registered = await oauth.registerClient({
      displayName: 'MySQL Client',
      principalId: 'principal:mysql',
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      allowedScopes: oauthConfig.supportedScopes,
    });
    const verifier = 'mysql-integration-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const code = await oauth.issueAuthorizationCode({
      clientId: registered.client.client_id,
      userId: 'env-admin',
      principalId: 'principal:mysql',
      redirectUri: registered.client.redirect_uris[0],
      resource: oauthConfig.resourceUrl,
      scopes: oauthConfig.supportedScopes,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
    const token = await oauth.exchangeAuthorizationCode({
      clientId: registered.client.client_id,
      clientSecret: registered.rawSecret,
      code,
      redirectUri: registered.client.redirect_uris[0],
      resource: oauthConfig.resourceUrl,
      codeVerifier: verifier,
    });
    assert.match(token.access_token, /^br_at_/);
    assert.match(token.refresh_token, /^br_rt_/);
    assert.ok(await oauthRepo.findAccessTokenByHash(oauth.hash(token.access_token)));
    await oauthRepo.recordAudit({
      requestId: 'req_mysql_integration',
      clientId: registered.client.client_id,
      principalId: 'principal:mysql',
      mcpMethod: 'tools/call',
      toolName: 'runtime_info',
      result: 'SUCCESS',
      httpStatus: 200,
      durationMs: 7,
    });
    assert.equal(await oauthRepo.countAuditLogs({ toolName: 'runtime_info' }), 1);

    // Recreate a clean target, then verify the automatic legacy SQLite import.
    await runner.fresh({ allowDestructive: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-report-legacy-import-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const legacyPath = path.join(dir, 'legacy.sqlite');
    const legacyDb = new Database(legacyPath);
    runLegacySchema(legacyDb);
    const now = new Date().toISOString();
    legacyDb
      .prepare(
        `INSERT INTO terminal_profiles
    (id,name,description,host,port,username,credential_envelope,tmux_session,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        '11111111-1111-4111-8111-111111111111',
        'Legacy Dev',
        'legacy',
        '127.0.0.1',
        22,
        'root',
        'opaque',
        'legacy',
        1,
        now,
        now,
      );
    legacyDb
      .prepare(
        `INSERT INTO mcp_oauth_clients
    (id,client_id,client_secret_hash,display_name,principal_id,profile_id,redirect_uris_json,allowed_scopes_json,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'client_legacy',
        'br_client_legacy',
        'hash',
        'Legacy Client',
        'principal:legacy',
        'legacy_profile',
        '[]',
        '[]',
        'active',
        now,
        now,
      );
    legacyDb
      .prepare(
        `INSERT INTO mcp_request_audit
    (id,request_id,client_id,principal_id,actor_id,mcp_method,tool_name,result,http_status,duration_ms,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'aud_legacy',
        'req_legacy',
        'br_client_legacy',
        'principal:legacy',
        null,
        'tools/call',
        'runtime_info',
        'SUCCESS',
        200,
        5,
        now,
      );
    legacyDb
      .prepare('INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,?)')
      .run('telegram_mcp_chat_id', '998877', now);
    legacyDb.close();

    const originalDbPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = legacyPath;
    try {
      const imported = await legacyImporter.importTo(adapter);
      assert.equal(imported.imported, true);
      assert.equal(imported.counts.terminal_profiles, 1);
      assert.equal(imported.counts.mcp_oauth_clients, 1);
      assert.equal(imported.counts.mcp_request_audit, 1);
      assert.equal(
        (await adapter.queryOne('SELECT COUNT(*) AS count FROM terminal_profiles')).count,
        1,
      );
      assert.equal(
        (
          await adapter.queryOne('SELECT value FROM system_settings WHERE `key` = ?', [
            'telegram.chat_id',
          ])
        ).value,
        '998877',
      );
      const retried = await legacyImporter.importTo(adapter);
      assert.equal(retried.imported, true);
      assert.equal(retried.reused, true);
      assert.deepEqual(retried.counts, imported.counts);
      assert.equal(
        (await adapter.queryOne('SELECT COUNT(*) AS count FROM terminal_profiles')).count,
        1,
      );
      assert.equal(
        (
          await adapter.queryOne(
            'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
            ['users'],
          )
        ).count,
        1,
      );
      assert.equal(
        (await adapter.queryOne('SELECT COUNT(*) AS count FROM users')).count,
        0,
        'legacy SQLite users must not be imported into MySQL users',
      );
      assert.equal(
        (
          await adapter.queryOne(
            'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
            ['sessions'],
          )
        ).count,
        0,
      );
    } finally {
      process.env.DATABASE_PATH = originalDbPath;
    }
  },
);
