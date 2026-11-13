#!/usr/bin/env node
/* Test-only restore preflight. Never targets an existing database or Railway. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const SCHEMA = '2026-11-12-initial';
function fail(message) { throw new Error('SANDBOX_RESTORE_REFUSED: ' + message); }
function inside(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function regular(file) {
  if (!fs.existsSync(file)) fail('source backup or manifest missing');
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(file) !== file)
    fail('source backup and manifest must be regular, non-symlink files');
}
function digest(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0)
      hash.update(chunk.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function metadata(file, manifestPath, expectedName = path.basename(file)) {
  regular(file);
  regular(manifestPath);
  let info;
  try { info = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { fail('invalid backup manifest'); }
  if (info.format !== 'bot-report-sqlite-backup-v1' ||
      info.file !== expectedName ||
      !/^[a-f0-9]{64}$/.test(info.sha256 || '') ||
      !Number.isSafeInteger(info.bytes) || info.bytes < 4096 ||
      info.schemaVersion !== SCHEMA ||
      typeof info.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(info.createdAt))) {
    fail('invalid or incompatible backup manifest');
  }
  if (fs.statSync(file).size !== info.bytes || digest(file) !== info.sha256) {
    fail('SHA-256 or size mismatch; backup is corrupt or modified');
  }
  return info;
}
function verify(file, manifestPath = file + '.manifest.json', expectedName) {
  const info = metadata(file, manifestPath, expectedName);
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('quick_check not ok');
    const tables = ['railway_schema_versions', 'system_settings', 'sessions',
      'mcp_oauth_clients', 'mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens', 'workers'];
    for (const table of tables) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
        fail('missing required table: ' + table);
    }
    const versions = db.prepare('SELECT version FROM railway_schema_versions').all();
    if (versions.length !== 1 || versions[0].version !== SCHEMA ||
        versions[0].version !== info.schemaVersion) fail('unsupported schema version');
    const owner = db.prepare("SELECT value FROM system_settings WHERE key='bootstrap.admin_password_hash'").get();
    if (!owner || typeof owner.value !== 'string' || !/^\$2[aby]\$/.test(owner.value))
      fail('owner account is not claimed');
    return {
      schema: versions[0].version,
      ownerPresent: true,
      sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
      clients: db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_clients').get().n,
      workers: db.prepare('SELECT COUNT(*) AS n FROM workers').get().n,
      sha256: info.sha256,
      bytes: info.bytes,
    };
  } catch (error) {
    if (error.message.startsWith('SANDBOX_RESTORE_REFUSED:')) throw error;
    fail('invalid SQLite content or incompatible schema');
  } finally { if (db) db.close(); }
}
function restore(source, volume) {
  if (process.env.W3_SANDBOX_ONLY !== '1') fail('explicit W3_SANDBOX_ONLY=1 required');
  if (!source || !volume) fail('usage: SOURCE_BACKUP NEW_EMPTY_SANDBOX_VOLUME');
  const tmp = fs.realpathSync(os.tmpdir());
  const src = path.resolve(source);
  const target = path.resolve(volume);
  if (!inside(src, tmp) || !inside(target, tmp) || src === target ||
      inside(src, target)) {
    fail('source and target must be separate sandbox locations under OS temp root');
  }
  if (!fs.existsSync(src)) fail('source backup missing');
  regular(src);
  if (!fs.existsSync(target) || !fs.lstatSync(target).isDirectory() ||
      fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target ||
      fs.readdirSync(target).length !== 0) {
    fail('destination must be an existing empty real sandbox directory');
  }
  const manifest = src + '.manifest.json';
  const evidence = verify(src, manifest);
  const output = path.join(target, 'bot_report.sqlite');
  const staged = path.join(target, '.restore-staged-' + crypto.randomUUID());
  try {
    fs.copyFileSync(src, staged, fs.constants.COPYFILE_EXCL);
    const checked = verify(staged, manifest, path.basename(src));
    if (JSON.stringify(checked) !== JSON.stringify(evidence)) fail('staged backup differs');
    fs.chmodSync(staged, 0o600);
    fs.renameSync(staged, output);
    process.stdout.write(JSON.stringify({
      status: 'RESTORED_SANDBOX_ONLY',
      ...evidence,
    }) + '\n');
  } finally {
    if (fs.existsSync(staged)) fs.rmSync(staged);
  }
}
try {
  if (require.main === module) restore(process.argv[2], process.argv[3]);
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
module.exports = { verify, restore };
