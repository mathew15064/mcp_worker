#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config/env');

const dbPath = config.DATABASE_PATH;
if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
const backupDir = path.join(path.dirname(dbPath), 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `bot_report_mcp_${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
const db = new Database(dbPath);
db.pragma('wal_checkpoint(TRUNCATE)');
db.backup(backupPath).then(() => {
  console.log(`Backup complete: ${backupPath}`);
  db.close();
}).catch(error => { console.error(`Backup failed: ${error.message}`); db.close(); process.exit(1); });
