#!/usr/bin/env node
/* Test-only restore preflight. Never targets an existing database or Railway. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
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
  const encrypted = info.format === 'bot-report-sqlite-backup-encrypted-v1';
  if (encrypted !== file.endsWith('.sqlite.enc'))
    fail('manifest encryption mode and snapshot filename disagree');
  if ((!encrypted && info.format !== 'bot-report-sqlite-backup-v1') ||
      info.file !== expectedName ||
      !/^[a-f0-9]{64}$/.test(info.sha256 || '') ||
      !Number.isSafeInteger(info.bytes) || info.bytes < 4096 ||
      info.schemaVersion !== SCHEMA ||
      typeof info.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(info.createdAt))) {
    fail('invalid or incompatible backup manifest');
  }
  if (encrypted &&
      (!info.encryption || info.encryption.algorithm !== 'aes-256-gcm' ||
       !/^[a-f0-9]{24}$/.test(info.encryption.nonce || '') ||
       !/^[a-f0-9]{32}$/.test(info.encryption.tag || '') ||
       !Number.isSafeInteger(info.plaintextBytes) || info.plaintextBytes < 4096 ||
       !/^[a-f0-9]{64}$/.test(info.plaintextSha256 || '') ||
       !info.authentication ||
       info.authentication.algorithm !== 'hmac-sha256-hkdf-v1' ||
       !/^[a-f0-9]{64}$/.test(info.authentication.tag || ''))) {
    fail('invalid encrypted backup manifest');
  }
  if (fs.statSync(file).size !== info.bytes || digest(file) !== info.sha256) {
    fail('SHA-256 or size mismatch; backup is corrupt or modified');
  }
  return info;
}
function authenticateManifest(info, key) {
  if (info.format !== 'bot-report-sqlite-backup-encrypted-v1')
    fail('plaintext manifest is not eligible for offsite recovery');
  const { authentication, ...payload } = info;
  const derived = Buffer.from(crypto.hkdfSync(
    'sha256', key, Buffer.from('bot-report-railway-backup-v1'),
    Buffer.from('manifest-authentication-v1'), 32,
  ));
  try {
    const expected = crypto.createHmac('sha256', derived)
      .update(JSON.stringify(payload), 'utf8').digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(authentication.tag, 'hex')))
      fail('authenticated manifest mismatch (wrong key or tampered metadata)');
  } finally { derived.fill(0); }
}
function inspectSqlite(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') fail('integrity_check not ok');
    const tables = ['railway_schema_versions', 'system_settings', 'sessions',
      'mcp_oauth_clients', 'mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens', 'workers'];
    for (const table of tables) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
        fail('missing required table: ' + table);
    }
    const versions = db.prepare('SELECT version FROM railway_schema_versions').all();
    if (versions.length !== 1 || versions[0].version !== SCHEMA)
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
  } catch (error) {
    if (error.message.startsWith('SANDBOX_RESTORE_REFUSED:')) throw error;
    fail('invalid SQLite content or incompatible schema');
  } finally { if (db) db.close(); }
}
function verify(file, manifestPath = file + '.manifest.json', expectedName) {
  const info = metadata(file, manifestPath, expectedName);
  if (info.format !== 'bot-report-sqlite-backup-v1')
    fail('encrypted file requires authenticated sandbox decryption');
  const checked = inspectSqlite(file);
  if (checked.schema !== info.schemaVersion) fail('manifest schema mismatch');
  return { ...checked, sha256: info.sha256, bytes: info.bytes };
}
function loadPrivateKey(source, destination) {
  const provided = process.env.W3_BACKUP_KEY_FILE;
  if (!provided) fail('W3_BACKUP_KEY_FILE required for encrypted restore');
  const file = path.resolve(provided);
  regular(file);
  if ((fs.statSync(file).mode & 0o077) !== 0 ||
      inside(file, path.dirname(source)) || inside(file, destination))
    fail('key must be private and separate from backup and destination');
  const key = fs.readFileSync(file);
  if (key.length !== 32) fail('decryption key must contain 32 raw bytes');
  return key;
}
async function restore(source, volume) {
  if (process.env.W3_SANDBOX_ONLY !== '1') fail('explicit W3_SANDBOX_ONLY=1 required');
  if (!source || !volume) fail('usage: SOURCE_BACKUP NEW_EMPTY_SANDBOX_VOLUME');
  const tmp = fs.realpathSync(os.tmpdir());
  const src = path.resolve(source);
  const target = path.resolve(volume);
  if (!inside(src, tmp) || !inside(target, tmp) || src === target ||
      inside(src, target) || inside(target, src)) {
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
  const info = metadata(src, manifest);
  const encrypted = info.format === 'bot-report-sqlite-backup-encrypted-v1';
  const output = path.join(target, 'bot_report.sqlite');
  const staged = path.join(target, '.restore-staged-' + crypto.randomUUID());
  let key;
  try {
    if (encrypted) {
      key = loadPrivateKey(src, target);
      authenticateManifest(info, key);
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm', key, Buffer.from(info.encryption.nonce, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(info.encryption.tag, 'hex'));
      try {
        await pipeline(
          fs.createReadStream(src),
          decipher,
          fs.createWriteStream(staged, { flags: 'wx', mode: 0o600 }),
        );
      } catch {
        fail('authenticated decryption failed (wrong key or tampered ciphertext)');
      }
      if (fs.statSync(staged).size !== info.plaintextBytes ||
          digest(staged) !== info.plaintextSha256)
        fail('decrypted plaintext SHA-256 or size mismatch');
    } else {
      fs.copyFileSync(src, staged, fs.constants.COPYFILE_EXCL);
    }
    const checked = inspectSqlite(staged);
    if (checked.schema !== info.schemaVersion) fail('restored schema mismatch');
    if (!encrypted) {
      const stagedEvidence = verify(staged, manifest, path.basename(src));
      const originalEvidence = verify(src, manifest);
      if (JSON.stringify(stagedEvidence) !== JSON.stringify(originalEvidence))
        fail('staged backup differs');
    }
    // Readonly SQLite inspection may leave empty WAL/SHM sidecars; never publish them.
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(staged + suffix)) fs.rmSync(staged + suffix);
    }
    // Nothing can be published until authentication, hash and schema checks pass.
    fs.chmodSync(staged, 0o600);
    fs.renameSync(staged, output);
    process.stdout.write(JSON.stringify({
      status: 'RESTORED_SANDBOX_ONLY',
      ...checked,
      sha256: info.sha256, bytes: info.bytes,
      encrypted,
    }) + '\n');
  } finally {
    if (key) key.fill(0);
    for (const file of [staged, staged + '-wal', staged + '-shm']) {
      if (fs.existsSync(file)) fs.rmSync(file);
    }
  }
}
if (require.main === module) {
  restore(process.argv[2], process.argv[3]).catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}
module.exports = { verify, restore };
