// Only invoked by the standalone installer after explicit --init consent.
// Never run migrations on a nonempty database or replace an existing bootstrap.
import fs from 'node:fs';
import store = require('../src/db/bootstrapConfigStore');
import manager = require('../src/db/databaseManager');
import {MysqlAdapter} from '../src/db/adapters/mysqlAdapter';
import {MigrationRunner} from '../src/db/migrationRunner';
import settings = require('../src/services/runtimeSettingsService');

async function main() {
  if (process.argv[2] !== '--init-fresh') throw new Error('Explicit fresh initialization consent required');
  if (store.exists()) {
    await manager.initialize();
    if (!manager.isMysqlReady()) throw new Error('Existing bootstrap is not ready; use Admin database recovery.');
    console.log('Existing ready bootstrap preserved.');
    return;
  }
  if (fs.existsSync(store.path) || manager.legacyAvailable()) throw new Error('Existing local database state; use Admin database workflow.');
  const password = process.env.BUNDLED_MYSQL_PASSWORD;
  if (!password) throw new Error('Bundled database credentials missing');
  const input = { host: 'mysql', port: 3306, database: 'bot_report', username: 'bot_report', password };
  const adapter = MysqlAdapter.create(input);
  try {
    await adapter.ping();
    const row = await adapter.queryOne<{count: number}>('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()');
    if (Number(row?.count || 0) !== 0) throw new Error('Nonempty database refused; use Admin database workflow.');
    await new MigrationRunner(adapter).migrate();
    await settings.seedDefaults(adapter);
    store.save(input);
    console.log('Fresh bundled MySQL initialized.');
  } finally { await adapter.close(); }
}
main().catch((error: unknown) => {
  const detail = error && typeof error === 'object' ? error as {code?: string;message?: string} : {};
  // Never print a connection string or arbitrary driver diagnostics.
  console.error('Bundled initialization failed: ' + (detail.code || (detail.message?.startsWith('Existing') || detail.message?.startsWith('Nonempty') ? detail.message : 'check database connectivity and state')));
  process.exitCode = 1;
}).finally(() => manager.close());
