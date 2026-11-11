#!/usr/bin/env node
const bootstrapConfigStore = require('../src/db/bootstrapConfigStore');
const { MysqlAdapter } = require('../src/db/adapters/mysqlAdapter');
const { MigrationRunner } = require('../src/db/migrationRunner');

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const direct = process.argv.find(value => value.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1];
  return fallback;
}

function hasFlag(name) { return process.argv.includes(`--${name}`); }

function printStatus(rows) {
  const width = Math.max('Migration'.length, ...rows.map(row => row.migration.length));
  console.log(`${'Ran?'.padEnd(7)} ${'Batch'.padEnd(7)} ${'Migration'.padEnd(width)} Executed at`);
  for (const row of rows) {
    console.log(`${(row.ran ? 'Yes' : 'No').padEnd(7)} ${String(row.batch ?? '-').padEnd(7)} ${row.migration.padEnd(width)} ${row.executed_at || '-'}`);
  }
}

async function main() {
  const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'migrate';
  if (!bootstrapConfigStore.exists()) {
    throw Object.assign(new Error('MySQL is not configured. Configure Database from /admin/settings first.'), { code: 'DATABASE_UNCONFIGURED' });
  }
  const config = bootstrapConfigStore.load();
  const adapter = MysqlAdapter.create(config);
  try {
    await adapter.ping();
    const runner = new MigrationRunner(adapter);
    if (command === 'migrate') {
      const result = await runner.migrate();
      if (!result.ran.length) console.log('Nothing to migrate.');
      else {
        console.log(`Migrated batch ${result.batch}:`);
        for (const name of result.ran) console.log(`  ${name}`);
      }
      return;
    }
    if (command === 'status') {
      printStatus(await runner.status());
      return;
    }
    if (command === 'rollback') {
      const rawStep = argValue('step', null);
      const options = rawStep === null ? {} : { steps: Math.max(1, Number.parseInt(rawStep, 10) || 1) };
      const result = await runner.rollback(options);
      if (!result.rolledBack.length) console.log('Nothing to rollback.');
      else result.rolledBack.forEach(name => console.log(`Rolled back: ${name}`));
      return;
    }
    if (command === 'reset') {
      if (process.env.NODE_ENV === 'production' && !hasFlag('force')) {
        throw Object.assign(new Error('reset is destructive in production. Re-run with --force.'), { code: 'DESTRUCTIVE_MIGRATION_BLOCKED' });
      }
      const result = await runner.reset();
      if (!result.rolledBack.length) console.log('Nothing to reset.');
      else result.rolledBack.forEach(name => console.log(`Rolled back: ${name}`));
      return;
    }
    if (command === 'fresh') {
      if (!hasFlag('force')) {
        throw Object.assign(new Error('fresh drops application schema. Re-run with --force.'), { code: 'DESTRUCTIVE_MIGRATION_BLOCKED' });
      }
      const result = await runner.fresh({ allowDestructive: true });
      console.log(`Fresh migration complete. Batch ${result.batch ?? '-'}, ${result.ran.length} migrations executed.`);
      return;
    }
    throw Object.assign(new Error(`Unknown migration command '${command}'. Use migrate, status, rollback, reset, or fresh.`), { code: 'MIGRATION_COMMAND_INVALID' });
  } finally {
    await adapter.close();
  }
}

main().catch(error => {
  console.error(`[${error.code || 'MIGRATION_ERROR'}] ${error.message}`);
  process.exit(1);
});
