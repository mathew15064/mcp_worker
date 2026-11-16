#!/usr/bin/env node
'use strict';

// Explicit offline transition from the previous SQLite filename.
// Both source and destination live on the same persistent volume; the source
// database is never deleted. Stop all server containers before using this.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

async function main() {
  if (process.argv[2] !== '--offline') {
    throw new Error('Usage: node dist/scripts/migrate-db-filename.cjs --offline (stop server first)');
  }
  const dir = path.resolve(process.env.MCP_WORKER_DATA_DIR || '/app/data');
  const oldPath = path.join(dir, 'bot_report.sqlite');
  const newPath = path.join(dir, 'mcp_worker.sqlite');
  const dirInfo = fs.lstatSync(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || fs.realpathSync(dir) !== dir) {
    throw new Error('SQLite volume must be a real directory');
  }
  const oldInfo = fs.lstatSync(oldPath, { throwIfNoEntry: false });
  if (!oldInfo || !oldInfo.isFile() || oldInfo.isSymbolicLink()) {
    throw new Error('No private regular legacy SQLite file was found');
  }
  if (fs.lstatSync(newPath, { throwIfNoEntry: false })) {
    throw new Error('Target SQLite already exists; refusing overwrite');
  }
  const source = new Database(oldPath, { readonly: true, fileMustExist: true });
  const stage = path.join(dir, '.mcp_worker-migrate-' + process.pid + '-' + Date.now() + '.sqlite');
  try {
    if (source.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Legacy SQLite integrity check failed');
    }
    await source.backup(stage);
    fs.chmodSync(stage, 0o600);
    const check = new Database(stage, { readonly: true, fileMustExist: true });
    try {
      if (check.pragma('integrity_check', { simple: true }) !== 'ok' ||
          check.pragma('foreign_key_check').length !== 0) {
        throw new Error('SQLite backup validation failed');
      }
    } finally { check.close(); }
    if (fs.lstatSync(newPath, { throwIfNoEntry: false })) {
      throw new Error('Target appeared during backup; refusing overwrite');
    }
    fs.renameSync(stage, newPath);
    console.log('Copied legacy SQLite database to mcp_worker.sqlite; original retained.');
  } finally {
    source.close();
    if (fs.existsSync(stage)) fs.rmSync(stage);
  }
}
main().catch(err => { console.error('Database filename migration refused: ' + err.message); process.exitCode = 1; });
