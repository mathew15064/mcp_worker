import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseAdapter, SqlValue } from '../src/db/contracts';
async function requireRow<T extends object>(
  adapter: DatabaseAdapter,
  sql: string,
  params: SqlValue[] = [],
): Promise<T> {
  const row = await adapter.queryOne<T>(sql, params);
  assert.ok(row, 'Missing SQL query result for integration assertion');
  return row;
}

const enabled = Boolean(process.env.MYSQL_TEST_HOST);

function mysqlConfig() {
  return {
    host: process.env.MYSQL_TEST_HOST || '127.0.0.1',
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

    const { MysqlAdapter } = await import('../src/db/adapters/mysqlAdapter.js');
    const { MigrationRunner } = await import('../src/db/migrationRunner.js');
    const { SettingsRepository } = (await import('../src/repositories/settingsRepository.js'))
      .default;
    const { WorkerRepository } = (await import('../src/repositories/workerRepository.js')).default;
    const { WorkerAuthService } = (await import('../src/services/workerAuthService.js')).default;
    const { McpOAuthRepository } = (await import('../src/repositories/mcpOAuthRepository.js'))
      .default;
    const { McpOAuthService } = (await import('../src/services/mcpOAuthService.js')).default;
    const legacyImporter = (await import('../src/services/legacySqliteImportService.js')).default;
    const Database = (await import('better-sqlite3')).default;
    const { runMigrations: runLegacySchema } = await import('../src/db/migrations.js');

    const adapter = MysqlAdapter.create(mysqlConfig());
    t.after(async () => {
      try {
        await new MigrationRunner(adapter).fresh({ allowDestructive: true });
      } catch {}
      await adapter.close();
    });

    await adapter.ping();
    const info = await adapter.serverInfo();
    assert.match(String(info.version), /^8\./);

    const { migrationFiles } = await import('../src/db/migrationRunner.js');
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
    assert.ok(worker);
    assert.equal(worker.name, 'Integration Worker');
    assert.equal(worker.enabled, true);
    assert.deepEqual(worker.capabilities, ['tmux.inspect', 'workspace.exec']);
    const disabledWorker = await workerRepo.setWorkerEnabled(worker.id, false);
    assert.ok(disabledWorker);
    assert.equal(disabledWorker.enabled, false);
    const enabledWorker = await workerRepo.setWorkerEnabled(worker.id, true);
    assert.ok(enabledWorker);
    assert.equal(enabledWorker.enabled, true);
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
      enabled: true,
    });
    assert.ok(workerProfile);
    assert.equal(workerProfile.transport, 'worker');
    assert.equal(
      'worker_name' in workerProfile ? workerProfile.worker_name : undefined,
      'Integration Worker',
    );

    const settings = new SettingsRepository(adapter);
    await settings.set('mcp.enabled', 'true');
    assert.equal(await settings.get('mcp.enabled'), 'true');

    // Historical SSH tables remain readable for nondestructive rollback/import.
    // Worker-only runtime never creates a new SSH profile.
    const historical = await adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) AS count FROM terminal_profiles',
    );
    assert.ok(historical);

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
    assert.ok(registered.client);
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
    assert.ok(token.refresh_token);
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
      assert.ok('counts' in imported && imported.counts);
      const importedCounts: Record<string, number> = imported.counts;
      assert.equal(importedCounts.terminal_profiles, 1);
      assert.equal(importedCounts.mcp_oauth_clients, 1);
      assert.equal(importedCounts.mcp_request_audit, 1);
      assert.equal(
        (
          await requireRow<{ count: number }>(
            adapter,
            'SELECT COUNT(*) AS count FROM terminal_profiles',
          )
        ).count,
        1,
      );
      assert.equal(
        (
          await requireRow<{ value: string }>(
            adapter,
            'SELECT value FROM system_settings WHERE `key` = ?',
            ['telegram.chat_id'],
          )
        ).value,
        '998877',
      );
      const retried = await legacyImporter.importTo(adapter);
      assert.equal(retried.imported, true);
      assert.equal(retried.reused, true);
      assert.deepEqual(retried.counts, imported.counts);
      assert.equal(
        (
          await requireRow<{ count: number }>(
            adapter,
            'SELECT COUNT(*) AS count FROM terminal_profiles',
          )
        ).count,
        1,
      );
      assert.equal(
        (
          await requireRow<{ count: number }>(
            adapter,
            'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
            ['users'],
          )
        ).count,
        1,
      );
      assert.equal(
        (await requireRow<{ count: number }>(adapter, 'SELECT COUNT(*) AS count FROM users')).count,
        0,
        'legacy SQLite users must not be imported into MySQL users',
      );
      assert.equal(
        (
          await requireRow<{ count: number }>(
            adapter,
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

void test(
  'MySQL survives ledger failure after ALTER, restart and concurrent migration startup',
  { skip: !enabled },
  async (t) => {
    const { MysqlAdapter } = await import('../src/db/adapters/mysqlAdapter.js');
    const { MigrationRunner } = await import('../src/db/migrationRunner.js');
    let adapter = MysqlAdapter.create(mysqlConfig());
    t.after(async () => {
      try {
        await new MigrationRunner(adapter).fresh({ allowDestructive: true });
      } finally {
        await adapter.close();
      }
    });
    await adapter.ping();
    const runner = new MigrationRunner(adapter);
    await runner.fresh({ allowDestructive: true });
    const now = new Date().toISOString();
    await adapter.execute(
      `INSERT INTO users (id,username,display_name,password_hash,role,status,principal_id,profile_id,session_version,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'owner',
        'owner',
        'Owner',
        'hashed',
        'user',
        'active',
        'principal:owner',
        'profile:owner',
        1,
        now,
        now,
      ],
    );
    for (const [id, scopes] of [
      ['read-only', ['bot_report.read']],
      ['pregranted', ['bot_report.read', 'bot_report.terminal', 'offline_access']],
    ] as const) {
      await adapter.execute(
        `INSERT INTO mcp_oauth_clients
       (id,client_id,client_secret_hash,display_name,principal_id,profile_id,owner_user_id,
       redirect_uris_json,allowed_scopes_json,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          id,
          'hash',
          id,
          'principal:owner',
          'profile:owner',
          'owner',
          '[]',
          JSON.stringify(scopes),
          'active',
          now,
          now,
        ],
      );
    }
    const grants = (db: typeof adapter) =>
      db.queryAll<{ id: string; allowed_scopes_json: string }>(
        'SELECT id, allowed_scopes_json FROM mcp_oauth_clients ORDER BY id',
      );
    const before = await grants(adapter);
    await runner.rollback({ steps: 1 });
    const target = '2026_11_02_000012_add_user_ownership_to_workers';
    // Save the method for restoration after the deliberate test-only failure.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const execute = MysqlAdapter.prototype.execute;
    let interrupted = false;
    MysqlAdapter.prototype.execute = async function (sql, params = []) {
      if (!interrupted && sql.startsWith('INSERT INTO migrations') && params[0] === target) {
        interrupted = true;
        throw new Error('TEST_LEDGER_FAILURE_AFTER_COMMITTED_DDL');
      }
      return execute.call(this, sql, params);
    };
    try {
      await assert.rejects(() => runner.migrate(), /TEST_LEDGER_FAILURE_AFTER_COMMITTED_DDL/);
    } finally {
      MysqlAdapter.prototype.execute = execute;
    }
    assert.equal(interrupted, true);
    assert.deepEqual(await grants(adapter), before);
    assert.equal(
      (
        await requireRow<{ n: number }>(
          adapter,
          'SELECT COUNT(*) AS n FROM migrations WHERE migration = ?',
          [target],
        )
      ).n,
      0,
    );
    assert.equal(
      (
        await requireRow<{ n: number }>(
          adapter,
          `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema=DATABASE() AND table_name='workers' AND column_name='owner_user_id'`,
        )
      ).n,
      1,
    );

    await adapter.close(); // true connection restart, not transaction rollback
    adapter = MysqlAdapter.create(mysqlConfig());
    await adapter.ping();
    const [a, b] = await Promise.all([
      new MigrationRunner(adapter).migrate(),
      new MigrationRunner(adapter).migrate(),
    ]);
    assert.equal(a.ran.length + b.ran.length, 1);
    assert.deepEqual(
      await grants(adapter),
      before,
      'migration must never widen or trim OAuth grants',
    );
    assert.equal(
      (
        await requireRow<{ n: number }>(
          adapter,
          'SELECT COUNT(*) AS n FROM migrations WHERE migration = ?',
          [target],
        )
      ).n,
      1,
    );
    for (const table of ['workers', 'worker_enrollment_tokens', 'mcp_oauth_clients']) {
      assert.equal(
        (
          await requireRow<{ n: number }>(
            adapter,
            `SELECT COUNT(*) AS n FROM information_schema.key_column_usage
       WHERE table_schema=DATABASE() AND table_name=? AND column_name='owner_user_id'
       AND referenced_table_name='users'`,
            [table],
          )
        ).n,
        1,
      );
    }
    const { McpOAuthRepository } = (await import('../src/repositories/mcpOAuthRepository.js'))
      .default;
    // A complete migration ledger cannot make a damaged MySQL source READY.
    await adapter.exec(
      'ALTER TABLE `mcp_oauth_access_tokens` DROP INDEX `idx_mcp_access_tokens_client`',
    );
    await assert.rejects(
      () => new MigrationRunner(adapter).inspectSource(),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'MYSQL_SCHEMA_INCOMPATIBLE',
    );
    await adapter.exec(
      'ALTER TABLE `mcp_oauth_access_tokens` ADD INDEX `idx_mcp_access_tokens_client` (`client_id`)',
    );
    assert.equal((await new MigrationRunner(adapter).inspectSource()).initialized, true);

    const repo = new McpOAuthRepository(adapter);
    await adapter.execute(
      `INSERT INTO mcp_oauth_access_tokens
     (id,token_hash,client_id,principal_id,resource,scopes_json,expires_at,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
      ['a', 'token-b', 'client-b', 'p', 'r', '[]', now, now],
    );
    await adapter.execute(
      `INSERT INTO mcp_oauth_refresh_tokens
     (id,token_hash,token_family_id,client_id,principal_id,resource,scopes_json,expires_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
      ['r', 'refresh-b', 'family', 'client-b', 'p', 'r', '[]', now, now],
    );
    await repo.revokeAccessTokenForClient('token-b', 'client-a');
    await repo.revokeRefreshTokenForClient('refresh-b', 'client-a');
    assert.equal(
      (
        await requireRow<{ revoked_at: string | null }>(
          adapter,
          'SELECT revoked_at FROM mcp_oauth_access_tokens WHERE token_hash=?',
          ['token-b'],
        )
      ).revoked_at,
      null,
    );
    assert.equal(
      (
        await requireRow<{ revoked_at: string | null }>(
          adapter,
          'SELECT revoked_at FROM mcp_oauth_refresh_tokens WHERE token_hash=?',
          ['refresh-b'],
        )
      ).revoked_at,
      null,
    );
    await repo.revokeAccessTokenForClient('token-b', 'client-b');
    await repo.revokeRefreshTokenForClient('refresh-b', 'client-b');
    assert.ok(
      (
        await requireRow<{ revoked_at: string | null }>(
          adapter,
          'SELECT revoked_at FROM mcp_oauth_access_tokens WHERE token_hash=?',
          ['token-b'],
        )
      ).revoked_at,
    );
    assert.ok(
      (
        await requireRow<{ revoked_at: string | null }>(
          adapter,
          'SELECT revoked_at FROM mcp_oauth_refresh_tokens WHERE token_hash=?',
          ['refresh-b'],
        )
      ).revoked_at,
    );
  },
);

void test(
  'Historical OAuth grant repair is atomic in disposable MySQL (dry-run policy, no production apply)',
  {
    skip:
      !enabled ||
      !['localhost', '127.0.0.1'].includes(process.env.MYSQL_TEST_HOST || '') ||
      !(process.env.MYSQL_TEST_DATABASE || '').startsWith('bot_report_test'),
  },
  async (t) => {
    const { MysqlAdapter } = await import('../src/db/adapters/mysqlAdapter.js');
    const { MigrationRunner } = await import('../src/db/migrationRunner.js');
    const db = MysqlAdapter.create(mysqlConfig());
    t.after(async () => {
      try {
        await new MigrationRunner(db).fresh({ allowDestructive: true });
      } finally {
        await db.close();
      }
    });
    await new MigrationRunner(db).fresh({ allowDestructive: true });
    const now = new Date().toISOString();
    const currentScopes = JSON.stringify([
      'bot_report.read',
      'bot_report.terminal',
      'offline_access',
    ]);
    const ownerReviewed = JSON.stringify(['bot_report.read']);
    for (const id of ['legacy-fixture', 'unrelated-fixture']) {
      await db.execute(
        `INSERT INTO mcp_oauth_clients
          (id,client_id,client_secret_hash,display_name,principal_id,profile_id,
           redirect_uris_json,allowed_scopes_json,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          id,
          'fixture-hash',
          id,
          'principal:fixture',
          'profile:fixture',
          '[]',
          currentScopes,
          'active',
          now,
          now,
        ],
      );
      await db.execute(
        `INSERT INTO mcp_oauth_access_tokens
          (id,token_hash,client_id,principal_id,resource,scopes_json,expires_at,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, `access-${id}`, id, 'principal:fixture', 'resource:fixture', currentScopes, now, now],
      );
      await db.execute(
        `INSERT INTO mcp_oauth_refresh_tokens
          (id,token_hash,token_family_id,client_id,principal_id,resource,scopes_json,expires_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          id,
          `refresh-${id}`,
          `family-${id}`,
          id,
          'principal:fixture',
          'resource:fixture',
          currentScopes,
          now,
          now,
        ],
      );
    }
    const clientId = 'legacy-fixture';
    const getScopes = async (id: string) =>
      (
        await requireRow<{ allowed_scopes_json: string }>(
          db,
          'SELECT allowed_scopes_json FROM mcp_oauth_clients WHERE client_id = ?',
          [id],
        )
      ).allowed_scopes_json;
    const activeTokens = async (table: string, id: string) =>
      (
        await requireRow<{ count: number }>(
          db,
          `SELECT COUNT(*) AS count FROM ${table} WHERE client_id = ? AND revoked_at IS NULL`,
          [id],
        )
      ).count;
    const applyFixture = (abort: boolean) =>
      db.transaction(async (tx) => {
        const row = await tx.queryOne<{ allowed_scopes_json: string }>(
          'SELECT allowed_scopes_json FROM mcp_oauth_clients WHERE client_id = ? FOR UPDATE',
          [clientId],
        );
        assert.equal(row?.allowed_scopes_json, currentScopes, 'must match approved snapshot');
        const updated = await tx.execute(
          'UPDATE mcp_oauth_clients SET allowed_scopes_json = ? WHERE client_id = ? AND allowed_scopes_json = ?',
          [ownerReviewed, clientId, currentScopes],
        );
        assert.equal(updated.changes, 1, 'optimistic grant precondition must succeed');
        for (const table of ['mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens']) {
          await tx.execute(
            `UPDATE ${table} SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL`,
            [now, clientId],
          );
        }
        if (abort) throw new Error('FIXTURE_ROLLBACK');
      });
    await assert.rejects(() => applyFixture(true), /FIXTURE_ROLLBACK/);
    assert.equal(await getScopes(clientId), currentScopes);
    for (const table of ['mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens']) {
      assert.equal(await activeTokens(table, clientId), 1, 'rollback preserves issued tokens');
    }
    await applyFixture(false);
    assert.equal(await getScopes(clientId), ownerReviewed, 'approved narrowed grants applied');
    assert.equal(await getScopes('unrelated-fixture'), currentScopes, 'unrelated grants unchanged');
    for (const table of ['mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens']) {
      assert.equal(await activeTokens(table, clientId), 0, 'issued tokens revoked with grant');
      assert.equal(await activeTokens(table, 'unrelated-fixture'), 1, 'unrelated tokens unchanged');
    }
    await assert.rejects(() => applyFixture(false), /must match approved snapshot/);
  },
);
