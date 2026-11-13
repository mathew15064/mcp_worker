#!/usr/bin/env node
/**
 * Explicit, fail-closed local SQLite export. This does NOT transfer to durable
 * off-host storage: operators must retrieve and encrypt the completed bundle.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
  const versions = db.prepare('SELECT version FROM railway_schema_versions').all() as {
    version: string;
  }[];
  if (versions.length !== 1 || versions[0].version !== SCHEMA) {
    throw new Error('Unsupported Railway SQLite schema version');
  }
  const owner = db
    .prepare("SELECT value FROM system_settings WHERE key='bootstrap.admin_password_hash'")
    .get() as { value?: string } | undefined;
  if (!owner || typeof owner.value !== 'string' || !/^\$2[aby]\$/.test(owner.value)) {
    throw new Error('Refusing export of unclaimed owner database');
  }
  return versions[0].version;
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
  const dataVolume = fs.realpathSync(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.dirname(dbPath));
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

  const name =
    'bot_report_mcp_' + new Date().toISOString().replace(/[:.]/g, '-') + '_' + crypto.randomUUID();
  const finished = path.join(exportDir, name + '.sqlite');
  const manifestPath = finished + '.manifest.json';
  const staged = path.join(exportDir, '.' + name + '.partial.sqlite');
  const manifestTmp = manifestPath + '.partial';
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
    const bytes = fs.statSync(staged).size;
    const digest = sha256(staged);
    const manifest = {
      format: 'bot-report-sqlite-backup-v1',
      file: path.basename(finished),
      sha256: digest,
      bytes,
      schemaVersion,
      createdAt: new Date().toISOString(),
    };
    fs.renameSync(staged, finished);
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(manifestTmp, manifestPath);
    completed = true;
    process.stdout.write(
      JSON.stringify({
        status: 'BACKUP_EXPORTED_LOCAL',
        path: finished,
        manifest: manifestPath,
        sha256: digest,
        bytes,
        schema: schemaVersion,
        sameMountTestOverride: sameMount,
      }) + '\n',
    );
  } finally {
    db.close();
    process.umask(previousUmask);
    for (const file of [staged, manifestTmp]) {
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
