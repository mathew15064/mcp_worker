import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config/env';

let dbInstance: Database.Database | null = null;
let currentDbPath: string | null = null;

const projectRoot = path.resolve(__dirname, '../../..');
const PROD_DB_PATH = path.resolve(projectRoot, 'data/bot_report.sqlite');
const COMPILED_DB_PATH = path.resolve(__dirname, '../../data/bot_report.sqlite');

export function getDb(customPath: string | null = null) {
  const targetPath = customPath || config.DATABASE_PATH;
  const resolvedTarget = path.resolve(targetPath);

  // FAIL-CLOSED DATA SAFETY GUARD
  if (
    process.env.NODE_ENV === 'test' &&
    (resolvedTarget === PROD_DB_PATH || resolvedTarget === COMPILED_DB_PATH)
  ) {
    throw new Error(
      '[DATA_SAFETY_VIOLATION] Refusing to open production SQLite database in test mode! Target: ' +
        resolvedTarget,
    );
  }

  if (dbInstance && currentDbPath === targetPath) {
    return dbInstance;
  }

  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (e) {
      // ignore
    }
    dbInstance = null;
    currentDbPath = null;
  }

  const dbDir = path.dirname(targetPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(targetPath);

  // WAL mode for high concurrency read/writes
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  if (!customPath) {
    dbInstance = db;
    currentDbPath = targetPath;
  }

  return db;
}

export function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (e) {
      // ignore if already closed
    }
    dbInstance = null;
    currentDbPath = null;
  }
}
