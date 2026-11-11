import { LibsqlAdapter } from '../src/db/adapters/libsqlAdapter';
import { MigrationRunner } from '../src/db/migrationRunner';

/**
 * Optional, non-destructive remote Turso probe.
 * Intentionally never creates tables, writes records or prints credentials.
 */
async function verifyRemoteLibsql(): Promise<void> {
  const url = process.env.LIBSQL_TEST_DATABASE_URL;
  const authToken = process.env.LIBSQL_TEST_AUTH_TOKEN;
  if (!url || !authToken) {
    throw Object.assign(
      new Error('Supply a separate test database URL/token through secure environment variables.'),
      { code: 'LIBSQL_REMOTE_TEST_NOT_CONFIGURED' },
    );
  }

  const adapter = await LibsqlAdapter.createRemote({ url, authToken });
  try {
    await adapter.ping();
    const version = await adapter.queryOne<{ version: string }>(
      'SELECT sqlite_version() AS version',
    );
    const status = await new MigrationRunner(adapter).inspectSource();
    // Output contains schema metadata only, never the URL, token or user data.
    console.log(
      JSON.stringify({
        connected: true,
        engine: 'libsql',
        sqliteVersion: version?.version ?? 'unknown',
        migrationTable: status.migrationTable,
        schemaInitialized: status.initialized,
        migrationCount: status.total,
        pendingCount: status.pending.length,
        readOnlyProbe: true,
      }),
    );
  } finally {
    await adapter.close();
  }
}

void verifyRemoteLibsql().catch((error: unknown) => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'REMOTE_PROBE_FAILED';
  console.error('[LIBSQL_REMOTE_PROBE] ' + code);
  process.exitCode = 1;
});
