const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config/env');

let dbInstance = null;
let currentDbPath = null;

const PROD_DB_PATH = path.resolve(__dirname, '../../data/bot_report.sqlite');

function getDb(customPath = null) {
  const targetPath = customPath || config.DATABASE_PATH;
  const resolvedTarget = path.resolve(targetPath);

  // FAIL-CLOSED DATA SAFETY GUARD
  if (process.env.NODE_ENV === 'test' && resolvedTarget === PROD_DB_PATH) {
    throw new Error('[DATA_SAFETY_VIOLATION] Refusing to open production SQLite database in test mode! Target: ' + resolvedTarget);
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

function closeDb() {
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

module.exports = {
  getDb,
  closeDb
};
