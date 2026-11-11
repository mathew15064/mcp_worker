// Only invoked by the standalone installer after explicit --init consent.
// Never run migrations on a nonempty database or replace an existing bootstrap.
const fs = require('node:fs');
const store = require('../src/db/bootstrapConfigStore');
const manager = require('../src/db/databaseManager');
const { MysqlAdapter } = require('../src/db/adapters/mysqlAdapter');
const { MigrationRunner } = require('../src/db/migrationRunner');
const settings = require('../src/services/runtimeSettingsService');

async function main() {
  if (process.argv[2] !== '--init-fresh') throw new Error('Explicit fresh initialization consent required');
  if (store.exists()) {
    await manager.initialize();
    if (!manager.isMysqlReady()) throw new Error('Existing bootstrap is not ready; use Admin database recovery.');
    console.log('Existing ready bootstrap preserved.');
    return;
  }
  if (fs.existsSync(store.path) || manager.legacyAvailable()) throw new Error('Existing local database state; use Admin database workflow.');
  const input = { host: 'mysql', port: 3306, database: 'bot_report', username: 'bot_report', password: process.env.BUNDLED_MYSQL_PASSWORD };
  if (!input.password) throw new Error('Bundled database credentials missing');
  const adapter = MysqlAdapter.create(input);
  try {
    await adapter.ping();
    const row = await adapter.queryOne('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()');
    if (Number(row.count) !== 0) throw new Error('Nonempty database refused; use Admin database workflow.');
    await new MigrationRunner(adapter).migrate();
    await settings.seedDefaults(adapter);
    store.save(input);
    console.log('Fresh bundled MySQL initialized.');
  } finally { await adapter.close(); }
}
main().catch(error => {
  // Never print a connection string or arbitrary driver diagnostics.
  console.error('Bundled initialization failed: ' + (error.code || (error.message.startsWith('Existing') || error.message.startsWith('Nonempty') ? error.message : 'check database connectivity and state')));
  process.exitCode = 1;
}).finally(() => manager.close());
