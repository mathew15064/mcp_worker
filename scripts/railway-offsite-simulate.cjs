#!/usr/bin/env node
/* T4: deterministic DISPOSABLE PC transport simulation, never a remote uploader. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
function refuse(message) { throw new Error('T4_OFFSITE_SIM_REFUSED: ' + message); }
function inside(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function mountId(directory) {
  let best = ''; let found;
  for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
    const fields = line.split(' - ')[0].split(' ');
    if (fields.length < 5) continue;
    const mounted = fields[4].replace(/\\([0-7]{3})/g,
      (_, code) => String.fromCharCode(parseInt(code, 8)));
    if (inside(directory, mounted) && mounted.length > best.length) {
      best = mounted; found = fields[0];
    }
  }
  if (!found) refuse('could not establish mount identity');
  return found;
}
function realPrivateDirectory(dir) {
  if (!fs.existsSync(dir)) refuse('source/destination directory missing');
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      fs.realpathSync(dir) !== dir || (stat.mode & 0o077))
    refuse('directories must be real private 0700 paths (no symlinks)');
}
function privateFile(file) {
  if (!fs.existsSync(file)) refuse('encrypted artifact or manifest missing');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file ||
      (stat.mode & 0o077) || stat.nlink !== 1)
    refuse('files must be private regular single-link paths (no symlinks/hardlinks)');
}
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function bundle(source) {
  if (!source.endsWith('.sqlite.enc')) refuse('plaintext SQLite is never offsite-safe');
  privateFile(source); privateFile(source + '.manifest.json');
  let info;
  try { info = JSON.parse(fs.readFileSync(source + '.manifest.json', 'utf8')); }
  catch { refuse('invalid manifest'); }
  if (info.format !== 'bot-report-sqlite-backup-encrypted-v1' ||
      info.file !== path.basename(source) ||
      !info.encryption || info.encryption.algorithm !== 'aes-256-gcm' ||
      !/^[a-f0-9]{24}$/.test(info.encryption.nonce || '') ||
      !/^[a-f0-9]{32}$/.test(info.encryption.tag || '') ||
      !info.authentication ||
      info.authentication.algorithm !== 'hmac-sha256-hkdf-v1' ||
      !/^[a-f0-9]{64}$/.test(info.authentication.tag || '') ||
      !Number.isSafeInteger(info.bytes) || info.bytes < 4096 ||
      !/^[a-f0-9]{64}$/.test(info.sha256 || '') ||
      fs.statSync(source).size !== info.bytes || hash(source) !== info.sha256)
    refuse('invalid, unauthenticated-format, or corrupt encrypted bundle');
  // No decryption keys are passed to this transporter. The restore client
  // verifies the *actual* HMAC and GCM tag using separately held keys.
  return { file: path.basename(source), bytes: info.bytes, sha256: info.sha256 };
}
function copyPair(operation, from, into) {
  if (process.env.T04_OFFSITE_SIMULATION_ONLY !== '1' ||
      process.env.CI || process.env.GITHUB_ACTIONS)
    refuse('explicit non-CI disposable PC simulation required');
  if (process.env.BACKUP_ENCRYPTION_KEY_FILE || process.env.W3_BACKUP_KEY_FILE)
    refuse('transport must never receive encryption keys');
  if (operation !== 'deposit' && operation !== 'retrieve') refuse('unknown operation');
  if (!from || !into) refuse('usage: deposit|retrieve SOURCE.sqlite.enc EMPTY_DIRECTORY');
  const source = path.resolve(from), destination = path.resolve(into);
  const tmp = fs.realpathSync(os.tmpdir());
  if (!inside(source, tmp) || !inside(destination, tmp))
    refuse('simulation paths must be below host temporary directory');
  realPrivateDirectory(path.dirname(source));
  realPrivateDirectory(destination);
  if (inside(source, destination) || inside(destination, path.dirname(source)) ||
      fs.readdirSync(destination).length !== 0)
    refuse('destination must be independent, new and empty');
  const sameMount = mountId(path.dirname(source)) === mountId(destination);
  if (sameMount && process.env.T04_LOGICAL_STORE_TEST_ONLY !== '1')
    refuse('same-mount transfer requires explicit logical-only test override');
  const original = bundle(source);
  const copied = path.join(destination, original.file);
  try {
    for (const suffix of ['', '.manifest.json']) {
      const fd = fs.openSync(copied + suffix, 'wx', 0o600);
      try { fs.writeFileSync(fd, fs.readFileSync(source + suffix)); }
      finally { fs.closeSync(fd); }
    }
    const verified = bundle(copied);
    if (verified.sha256 !== original.sha256 || verified.bytes !== original.bytes)
      refuse('transfer readback mismatch');
    process.stdout.write(JSON.stringify({
      status: operation === 'deposit' ? 'PC_SIMULATED_DEPOSIT_ONLY' : 'PC_SIMULATED_RETRIEVAL_ONLY',
      artifact: copied, manifest: copied + '.manifest.json',
      sha256: original.sha256, sameMountLogicalOnly: sameMount,
      remoteStorageVerified: false,
    }) + '\n');
  } catch (error) {
    for (const suffix of ['', '.manifest.json']) {
      if (fs.existsSync(copied + suffix)) fs.rmSync(copied + suffix);
    }
    throw error;
  }
}
if (require.main === module) {
  try { copyPair(process.argv[2], process.argv[3], process.argv[4]); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { copyPair };
