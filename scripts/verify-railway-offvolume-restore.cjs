#!/usr/bin/env node
/* Destructive restore is intentionally LIMITED to a new, empty /tmp sandbox volume.
 * Not a production restore command. The completed online backup must be off-volume. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

function fail(message) { throw new Error('SANDBOX_RESTORE_REFUSED: ' + message); }
function inside(file, dir) { return file.startsWith(dir + path.sep); }
function verify(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('quick_check not ok');
    const tables = ['railway_schema_versions', 'system_settings', 'sessions',
      'mcp_oauth_clients', 'mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens', 'workers'];
    for (const table of tables) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
        fail('missing required table: ' + table);
    }
    const versions = db.prepare('SELECT version FROM railway_schema_versions').all();
    if (versions.length !== 1 || versions[0].version !== '2026-11-12-initial')
      fail('unsupported schema version');
    const owner = db.prepare("SELECT value FROM system_settings WHERE key='bootstrap.admin_password_hash'").get();
    if (!owner || typeof owner.value !== 'string' || !/^\$2[aby]\$/.test(owner.value))
      fail('owner account is not claimed');
    return {
      schema: versions[0].version,
      ownerPresent: true,
      sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
      clients: db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_clients').get().n,
      workers: db.prepare('SELECT COUNT(*) AS n FROM workers').get().n,
    };
  } finally { db.close(); }
}
function restore(source, volume) {
  if (process.env.W3_SANDBOX_ONLY !== '1') fail('explicit W3_SANDBOX_ONLY=1 required');
  if (!source || !volume) fail('usage: SOURCE_BACKUP NEW_EMPTY_SANDBOX_VOLUME');
  const tmp = fs.realpathSync(os.tmpdir());
  const src = path.resolve(source);
  const target = path.resolve(volume);
  if (!inside(src, tmp) || !inside(target, tmp) ||
      src === target || inside(src, target) || inside(target, path.dirname(src) + '/volume'))
    fail('source and target must be independent paths beneath the sandbox temp root');
  if (!fs.existsSync(src)) fail('source backup missing');
  const srcInfo = fs.lstatSync(src);
  if (!srcInfo.isFile() || srcInfo.isSymbolicLink()) fail('source must be a regular file');
  if (!fs.existsSync(target) || fs.realpathSync(target) !== target ||
      !fs.lstatSync(target).isDirectory() || fs.readdirSync(target).length !== 0)
    fail('destination must be a real, empty existing sandbox directory');
  const evidence = verify(src);
  const output = path.join(target, 'bot_report.sqlite');
  const staged = path.join(target, '.restore-staged-' + crypto.randomUUID());
  try {
    fs.copyFileSync(src, staged, fs.constants.COPYFILE_EXCL);
    const checked = verify(staged);
    if (JSON.stringify(checked) !== JSON.stringify(evidence)) fail('staged backup differs');
    fs.chmodSync(staged, 0o600);
    fs.renameSync(staged, output);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    process.stdout.write(JSON.stringify({
      status: 'RESTORED_SANDBOX_ONLY', sha256: hash, bytes: fs.statSync(output).size,
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
