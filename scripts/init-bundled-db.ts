// Explicit, non-destructive SQLite initialization for ./setup.sh --init.
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config/env';
import manager from '../src/db/databaseManager';
import { getDb, closeDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { seedInitialAdmin } from '../src/db/seed';
import { assertRailwaySqliteSchema } from '../src/db/sqliteSchemaValidation';

async function main() {
  if (process.argv[2] !== '--init-fresh') {
    throw new Error('Explicit initialization requires --init-fresh');
  }
  const oldBootstrap = path.resolve(
    process.cwd(),
    process.env.BOOTSTRAP_CONFIG_PATH || 'data/bootstrap-config.json',
  );
  if (fs.existsSync(oldBootstrap)) {
    throw new Error('Obsolete database bootstrap detected; use a clean SQLite data directory.');
  }
  const target = config.DATABASE_PATH;
  if (fs.existsSync(target)) {
    await manager.initialize();
    if (!manager.isSqlReady()) throw new Error('Existing SQLite is not ready; data preserved.');
    console.log('Existing ready SQLite database preserved.');
    return;
  }
  const parent = path.dirname(target);
  if (fs.realpathSync(parent) !== parent) throw new Error('SQLite directory symlink refused.');
  // The container entrypoint also sets umask 077. Never publish a readable DB.
  process.umask(0o077);
  const db = getDb();
  db.transaction(() => {
    runMigrations(db);
    seedInitialAdmin(db);
    assertRailwaySqliteSchema(db);
    db.exec(
      'CREATE TABLE IF NOT EXISTS railway_schema_versions (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO railway_schema_versions(version, applied_at) VALUES (?, ?)').run(
      '2026-11-12-initial',
      new Date().toISOString(),
    );
  })();
  if (
    db.pragma('integrity_check', { simple: true }) !== 'ok' ||
    (db.pragma('foreign_key_check') as unknown[]).length
  ) {
    throw new Error('SQLite integrity validation failed; database preserved for inspection.');
  }
  fs.chmodSync(target, 0o600);
  console.log('Fresh SQLite initialized.');
}

main()
  .catch((error: unknown) => {
    console.error(
      'SQLite initialization refused: ' +
        (error instanceof Error ? error.message : 'unknown error'),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await manager.close();
    closeDb();
  });
