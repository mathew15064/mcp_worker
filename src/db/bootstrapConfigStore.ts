import fs from 'node:fs';
import path from 'node:path';
import { encryptString, decryptString } from '../services/applicationKeyService';
interface DatabaseInput { host?: unknown; port?: unknown; database?: unknown; username?: unknown; password?: unknown; ssl?: unknown }
interface BootstrapDocument {version: number; database: DatabaseInput & {password_envelope: string}; saved_at?: string}
function errorCode(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined; }

const AAD = 'bot_report:mysql-bootstrap:v1';

function configPath() {
  return path.resolve(process.cwd(), process.env.BOOTSTRAP_CONFIG_PATH || 'data/bootstrap-config.json');
}

function validationError(message: string) { return Object.assign(new Error(message), {code: 'INVALID_DATABASE_CONFIG'}); }

function normalizeDatabaseConfig(input: DatabaseInput, { requirePassword = true } = {}) {
  if (!input || typeof input !== 'object') throw validationError('Database configuration is required.');
  const host = String(input.host || '').trim();
  const port = Number(input.port || 3306);
  const database = String(input.database || '').trim();
  const username = String(input.username || '').trim();
  const password = input.password === undefined || input.password === null ? '' : String(input.password);
  const ssl = input.ssl === true || input.ssl === 'true' || input.ssl === 'on';

  if (!host || host.length > 255 || /[\x00-\x1f\x7f]/.test(host)) throw validationError('MySQL host is required and must be at most 255 characters.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw validationError('MySQL port must be between 1 and 65535.');
  if (!database || database.length > 128 || !/^[A-Za-z0-9_$.-]+$/.test(database)) throw validationError('MySQL database name is invalid.');
  if (!username || username.length > 128 || /[\x00-\x1f\x7f]/.test(username)) throw validationError('MySQL username is required and must be at most 128 characters.');
  if (requirePassword && !password) throw validationError('MySQL password is required.');
  if (Buffer.byteLength(password, 'utf8') > 4096) throw validationError('MySQL password is too long.');

  return { host, port, database, username, password, ssl };
}

class BootstrapConfigStore {
  get path() { return configPath(); }

  exists() {
    try { return fs.statSync(this.path).isFile(); } catch (_) { return false; }
  }

  load() {
    if (!this.exists()) return null;
    try {
      const parsed: BootstrapDocument = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (parsed?.version !== 1 || !parsed.database) throw validationError('Bootstrap database configuration is invalid.');
      const password = decryptString(parsed.database.password_envelope, AAD, 'enc:v1');
      return normalizeDatabaseConfig({ ...parsed.database, password }, { requirePassword: true });
    } catch (error) {
      if (errorCode(error) === 'INVALID_DATABASE_CONFIG' || errorCode(error) === 'APPLICATION_KEY_INVALID') throw error;
      const wrapped = Object.assign(new Error('Bootstrap database configuration could not be loaded.'), {code: 'BOOTSTRAP_CONFIG_INVALID'});
      throw wrapped;
    }
  }

  readPublic() {
    if (!this.exists()) return null;
    try {
      const parsed: BootstrapDocument = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (parsed?.version !== 1 || !parsed.database) return null;
      return {
        host: String(parsed.database.host || ''),
        port: Number(parsed.database.port || 3306),
        database: String(parsed.database.database || ''),
        username: String(parsed.database.username || ''),
        ssl: Boolean(parsed.database.ssl),
        hasPassword: Boolean(parsed.database.password_envelope),
        savedAt: parsed.saved_at || null
      };
    } catch (_) { return null; }
  }

  save(input: DatabaseInput) {
    const value = normalizeDatabaseConfig(input, { requirePassword: true });
    const target = this.path;
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const document = {
      version: 1,
      database: {
        host: value.host,
        port: value.port,
        database: value.database,
        username: value.username,
        ssl: value.ssl,
        password_envelope: encryptString(value.password, AAD, 'enc:v1')
      },
      saved_at: new Date().toISOString()
    };
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, target);
    try { fs.chmodSync(target, 0o600); } catch (_) {}
    return this.readPublic();
  }

  remove() {
    try { fs.unlinkSync(this.path); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}

const instance = Object.assign(new BootstrapConfigStore(), {BootstrapConfigStore, normalizeDatabaseConfig});
export = instance;
