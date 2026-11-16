#!/usr/bin/env node
/**
 * Explicit, fail-closed local SQLite export. This does NOT transfer to durable
 * off-host storage: only the authenticated encrypted bundle is eligible for
 * a separately approved external transfer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';

const SCHEMA = '2026-11-12-initial';

function contained(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function mountId(directory: string): string {
  // Mount IDs, unlike st_dev, distinguish bind mounts and Docker volumes.
  const records = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
  let longest = -1;
  let selected = '';
  for (const record of records) {
    const fields = record.split(' - ')[0].split(' ');
    if (fields.length < 5) continue;
    const mountPoint = fields[4].replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
    if (contained(directory, mountPoint) && mountPoint.length > longest) {
      longest = mountPoint.length;
      selected = fields[0];
    }
  }
  if (!selected) throw new Error('Unable to establish destination mount identity');
  return selected;
}

function validateDatabase(db: Database.Database): string {
  if (db.pragma('quick_check', { simple: true }) !== 'ok') {
    throw new Error('SQLite quick_check failed');
  }
  const versions = db.prepare('SELECT version FROM schema_versions').all() as {
    version: string;
  }[];
  if (versions.length !== 1 || versions[0].version !== SCHEMA) {
    throw new Error('Unsupported SQLite schema version');
  }
  // The standalone server authenticates the administrator using .env.setup,
  // not a database-backed remote owner claim.
  const tableNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((row) => row.name),
  );
  for (const name of [
    'users',
    'sessions',
    'system_settings',
    'workers',
    'worker_profiles',
    'worker_enrollment_tokens',
    'mcp_oauth_clients',
    'mcp_oauth_authorization_codes',
    'mcp_oauth_access_tokens',
    'mcp_oauth_refresh_tokens',
    'mcp_request_audit',
    'terminal_profiles',
    'terminal_connection_audit',
  ]) {
    if (!tableNames.has(name)) throw new Error('SQLite schema missing required table');
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length) {
    throw new Error('SQLite foreign key check failed');
  }
  return versions[0].version;
}

function encryptionKey(dataVolume: string, exportDir: string): Buffer | undefined {
  const provided = process.env.BACKUP_ENCRYPTION_KEY_FILE;
  if (!provided) return undefined;
  const file = path.resolve(provided);
  if (!fs.existsSync(file)) throw new Error('Encryption key file is missing');
  const info = fs.lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    fs.realpathSync(file) !== file ||
    (info.mode & 0o077) !== 0 ||
    contained(file, dataVolume) ||
    contained(file, exportDir)
  ) {
    throw new Error(
      'Encryption key must be a private regular file outside data and export volumes',
    );
  }
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error('Encryption key must be exactly 32 raw bytes');
  return key;
}

function encryptionStagingDir(dataVolume: string, exportDir: string): string {
  const value = process.env.BACKUP_STAGING_DIR;
  if (!value)
    throw new Error('Encrypted export requires an explicit private tmpfs BACKUP_STAGING_DIR');
  const dir = path.resolve(value);
  if (!fs.existsSync(dir)) throw new Error('Encrypted staging directory does not exist');
  const info = fs.lstatSync(dir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    fs.realpathSync(dir) !== dir ||
    (info.mode & 0o077) !== 0 ||
    contained(dir, dataVolume) ||
    contained(dir, exportDir) ||
    contained(dataVolume, dir) ||
    contained(exportDir, dir) ||
    fs.statfsSync(dir).type !== 0x01021994 ||
    mountId(dir) === mountId(dataVolume) ||
    mountId(dir) === mountId(exportDir)
  ) {
    throw new Error(
      'Encrypted staging must be a private tmpfs directory apart from database/export',
    );
  }
  return dir;
}

async function encryptSnapshot(source: string, destination: string, key: Buffer) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  await pipeline(
    fs.createReadStream(source),
    cipher,
    fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  );
  return {
    algorithm: 'aes-256-gcm',
    nonce: nonce.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

function sha256(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let size: number;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function main(): Promise<void> {
  if (!process.env.BACKUP_EXPORT_DIR) {
    throw new Error('BACKUP_EXPORT_DIR must identify an existing off-volume directory');
  }
  if (!process.env.DATABASE_PATH) {
    throw new Error('DATABASE_PATH must explicitly identify the SQLite source');
  }
  const dbPath = path.resolve(process.env.DATABASE_PATH);
  if (
    !fs.existsSync(dbPath) ||
    !fs.lstatSync(dbPath).isFile() ||
    fs.lstatSync(dbPath).isSymbolicLink() ||
    fs.realpathSync(dbPath) !== dbPath
  ) {
    throw new Error('Database must be an existing regular file (no symlinks)');
  }
  const dataVolume = fs.realpathSync(process.env.MCP_WORKER_DATA_DIR || path.dirname(dbPath));
  if (!contained(dbPath, dataVolume)) {
    throw new Error('DATABASE_PATH must be within its configured data volume');
  }
  const exportDir = path.resolve(process.env.BACKUP_EXPORT_DIR);
  if (
    !fs.existsSync(exportDir) ||
    !fs.lstatSync(exportDir).isDirectory() ||
    fs.lstatSync(exportDir).isSymbolicLink() ||
    fs.realpathSync(exportDir) !== exportDir ||
    contained(exportDir, dataVolume) ||
    contained(dataVolume, exportDir)
  ) {
    throw new Error(
      'Export must be an existing independent real directory outside the data volume',
    );
  }
  const sameMount = mountId(path.dirname(dbPath)) === mountId(exportDir);
  const disposableTestOverride =
    process.env.NODE_ENV === 'test' &&
    process.env.BACKUP_ALLOW_LOGICAL_VOLUME_TEST_ONLY === '1' &&
    contained(dbPath, fs.realpathSync(os.tmpdir())) &&
    contained(exportDir, fs.realpathSync(os.tmpdir()));
  if (sameMount && !disposableTestOverride) {
    throw new Error('Export destination shares the SQLite data mount; refusing on-volume backup');
  }

  const key = encryptionKey(dataVolume, exportDir);
  const stagingDir = key ? encryptionStagingDir(dataVolume, exportDir) : exportDir;
  const name =
    'mcp_worker_mcp_' + new Date().toISOString().replace(/[:.]/g, '-') + '_' + crypto.randomUUID();
  const finished = path.join(exportDir, name + (key ? '.sqlite.enc' : '.sqlite'));
  const manifestPath = finished + '.manifest.json';
  const staged = path.join(stagingDir, '.' + name + '.partial.sqlite');
  const manifestTmp = manifestPath + '.partial';
  const encryptedTmp = path.join(exportDir, '.' + name + '.partial.enc');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  // SQLite may create its .partial file before chmod: protect it from birth.
  const previousUmask = process.umask(0o077);
  let completed = false;
  try {
    validateDatabase(db);
    // Online backup uses SQLite's snapshot API. Never checkpoint/truncate an
    // active writer's WAL to take a backup, and never copy an open .sqlite file.
    await db.backup(staged);
    fs.chmodSync(staged, 0o600);
    const copy = new Database(staged, { readonly: true, fileMustExist: true });
    let schemaVersion: string;
    try {
      schemaVersion = validateDatabase(copy);
    } finally {
      copy.close();
    }
    const plaintextBytes = fs.statSync(staged).size;
    const plaintextSha256 = sha256(staged);
    const encryption = key ? await encryptSnapshot(staged, encryptedTmp, key) : undefined;
    const finalizedFile = key ? encryptedTmp : staged;
    const bytes = fs.statSync(finalizedFile).size;
    const digest = sha256(finalizedFile);
    const manifest = {
      format: key ? 'mcp_worker-sqlite-backup-encrypted-v1' : 'mcp_worker-sqlite-backup-v1',
      file: path.basename(finished),
      sha256: digest,
      bytes,
      schemaVersion,
      createdAt: new Date().toISOString(),
      ...(encryption ? { encryption, plaintextBytes, plaintextSha256 } : {}),
    };
    // The ciphertext GCM tag alone cannot authenticate unauthenticated JSON
    // metadata. Derive a distinct manifest MAC key; never store it with output.
    const authenticatedManifest = key
      ? {
          ...manifest,
          authentication: {
            algorithm: 'hmac-sha256-hkdf-v1',
            tag: crypto
              .createHmac(
                'sha256',
                Buffer.from(
                  crypto.hkdfSync(
                    'sha256',
                    key,
                    Buffer.from('mcp_worker-railway-backup-v1'),
                    Buffer.from('manifest-authentication-v1'),
                    32,
                  ),
                ),
              )
              .update(JSON.stringify(manifest), 'utf8')
              .digest('hex'),
          },
        }
      : manifest;
    fs.renameSync(finalizedFile, finished);
    fs.writeFileSync(manifestTmp, JSON.stringify(authenticatedManifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(manifestTmp, manifestPath);
    completed = true;
    process.stdout.write(
      JSON.stringify({
        status: key ? 'BACKUP_EXPORTED_ENCRYPTED_LOCAL' : 'BACKUP_EXPORTED_LOCAL',
        path: finished,
        manifest: manifestPath,
        sha256: digest,
        bytes,
        schema: schemaVersion,
        sameMountTestOverride: sameMount,
        encrypted: Boolean(key),
      }) + '\n',
    );
  } finally {
    db.close();
    process.umask(previousUmask);
    if (key) key.fill(0);
    for (const file of [staged, staged + '-wal', staged + '-shm', encryptedTmp, manifestTmp]) {
      if (fs.existsSync(file)) fs.rmSync(file);
    }
    if (!completed) {
      // The manifest is the commit marker. Incomplete bundles are never valid.
      if (fs.existsSync(finished)) fs.rmSync(finished);
      if (fs.existsSync(manifestPath)) fs.rmSync(manifestPath);
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    'BACKUP_REFUSED: ' + (error instanceof Error ? error.message : 'unknown error') + '\n',
  );
  process.exitCode = 1;
});
