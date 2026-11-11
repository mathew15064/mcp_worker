const Database = require('better-sqlite3');
const fs = require('fs');
const config = require('../config/env');

const TABLES = Object.freeze([
  { name: 'terminal_profiles', columns: ['id','name','description','host','port','username','credential_envelope','host_key_fingerprint','tmux_session','enabled','created_at','updated_at'] },
  { name: 'terminal_connection_audit', columns: ['id','terminal_profile_id','profile_name_snapshot','actor_id','event_type','outcome','detail_code','created_at'] },
  { name: 'mcp_oauth_clients', columns: ['id','client_id','client_secret_hash','display_name','principal_id','profile_id','redirect_uris_json','allowed_scopes_json','status','created_at','updated_at','last_authorized_at'] },
  { name: 'mcp_oauth_authorization_codes', columns: ['id','code_hash','client_id','user_id','principal_id','redirect_uri','resource','scopes_json','code_challenge','code_challenge_method','expires_at','used_at','created_at'] },
  { name: 'mcp_oauth_access_tokens', columns: ['id','token_hash','client_id','principal_id','resource','scopes_json','expires_at','revoked_at','created_at','last_used_at'] },
  { name: 'mcp_oauth_refresh_tokens', columns: ['id','token_hash','token_family_id','client_id','principal_id','resource','scopes_json','expires_at','revoked_at','replaced_by_hash','created_at','last_used_at'] },
  { name: 'mcp_request_audit', columns: ['id','request_id','client_id','principal_id','actor_id','mcp_method','tool_name','result','http_status','duration_ms','created_at'] }
]);

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function rowsFor(db, spec) {
  if (!tableExists(db, spec.name)) return [];
  const existingColumns = new Set(db.prepare(`PRAGMA table_info(${spec.name})`).all().map(row => row.name));
  const cols = spec.columns.filter(column => existingColumns.has(column));
  if (!cols.length) return [];
  return db.prepare(`SELECT ${cols.map(column => `\"${column}\"`).join(', ')} FROM \"${spec.name}\"`).all();
}

class LegacySqliteImportService {
  available() {
    try { const stat = fs.statSync(config.DATABASE_PATH); return stat.isFile() && stat.size > 0; } catch (_) { return false; }
  }

  inspect() {
    if (!this.available()) return { available: false, path: config.DATABASE_PATH, counts: {} };
    const db = new Database(config.DATABASE_PATH, { readonly: true, fileMustExist: true });
    try {
      const counts = {};
      for (const spec of TABLES) counts[spec.name] = tableExists(db, spec.name) ? Number(db.prepare(`SELECT COUNT(*) AS count FROM \"${spec.name}\"`).get().count) : 0;
      counts.system_settings = tableExists(db, 'system_settings') ? Number(db.prepare('SELECT COUNT(*) AS count FROM system_settings').get().count) : 0;
      return { available: true, path: config.DATABASE_PATH, counts };
    } finally { db.close(); }
  }

  async importTo(mysqlAdapter) {
    if (!this.available()) return { imported: false, reason: 'NO_LEGACY_DATABASE', counts: {} };
    const source = new Database(config.DATABASE_PATH, { readonly: true, fileMustExist: true });
    try {
      const sourceRows = new Map(TABLES.map(spec => [spec.name, rowsFor(source, spec)]));
      const counts = Object.fromEntries(TABLES.map(spec => [spec.name, (sourceRows.get(spec.name) || []).length]));
      const alreadyImported = await mysqlAdapter.queryOne("SELECT `value` FROM system_settings WHERE `key` = 'storage.legacy_imported_at' LIMIT 1");

      if (alreadyImported) {
        for (const spec of TABLES) {
          const target = await mysqlAdapter.queryOne(`SELECT COUNT(*) AS count FROM \`${spec.name}\``);
          if (Number(target?.count || 0) !== counts[spec.name]) {
            const error = new Error(`Existing legacy-import marker does not match '${spec.name}' row count.`);
            error.code = 'LEGACY_IMPORT_VERIFY_FAILED';
            throw error;
          }
        }
        return { imported: true, reused: true, counts };
      }

      for (const spec of TABLES) {
        const targetCount = await mysqlAdapter.queryOne(`SELECT COUNT(*) AS count FROM \`${spec.name}\``);
        if (Number(targetCount?.count || 0) > 0) {
          const error = new Error(`Target MySQL table '${spec.name}' is not empty. Refusing automatic legacy import.`);
          error.code = 'MYSQL_TARGET_NOT_EMPTY';
          throw error;
        }
      }

      const legacySettings = tableExists(source, 'system_settings')
        ? source.prepare('SELECT key, value FROM system_settings').all()
        : [];
      const legacySettingMap = new Map(legacySettings.map(row => [String(row.key), String(row.value ?? '')]));
      const now = new Date().toISOString();

      await mysqlAdapter.transaction(async tx => {
        for (const spec of TABLES) {
          const rows = sourceRows.get(spec.name) || [];
          for (const row of rows) {
            const columns = spec.columns.filter(column => Object.prototype.hasOwnProperty.call(row, column));
            const placeholders = columns.map(() => '?').join(', ');
            await tx.execute(`INSERT INTO \`${spec.name}\` (${columns.map(column => `\`${column}\``).join(', ')}) VALUES (${placeholders})`, columns.map(column => row[column]));
          }
        }

        const normalizedSettings = {
          'mcp.enabled': process.env.MCP_ENABLED !== 'false' ? 'true' : 'false',
          'mcp.public_base_url': String(process.env.MCP_PUBLIC_BASE_URL || 'http://localhost:3333').replace(/\/+$/, ''),
          'mcp.access_token_ttl_seconds': String(parseInt(process.env.MCP_ACCESS_TOKEN_TTL_SECONDS || '900', 10)),
          'mcp.refresh_token_ttl_seconds': String(parseInt(process.env.MCP_REFRESH_TOKEN_TTL_SECONDS || '2592000', 10)),
          'mcp.auth_code_ttl_seconds': String(parseInt(process.env.MCP_AUTH_CODE_TTL_SECONDS || '300', 10)),
          'mcp.rate_limit_per_minute': String(parseInt(process.env.MCP_RATE_LIMIT_PER_MINUTE || '120', 10)),
          'telegram.enabled': legacySettingMap.get('telegram_mcp_enabled') ?? legacySettingMap.get('telegram_enabled') ?? 'false',
          'telegram.chat_id': legacySettingMap.get('telegram_mcp_chat_id') ?? legacySettingMap.get('telegram_chat_id') ?? '',
          'telegram.bot_token': legacySettingMap.get('telegram_mcp_bot_token') ?? legacySettingMap.get('telegram_bot_token') ?? '',
          'storage.legacy_imported_at': now
        };
        for (const [key, value] of Object.entries(normalizedSettings)) {
          await tx.execute('INSERT INTO system_settings (`key`, `value`, updated_at) VALUES (?, ?, ?)', [key, value, now]);
        }

        for (const spec of TABLES) {
          const target = await tx.queryOne(`SELECT COUNT(*) AS count FROM \`${spec.name}\``);
          if (Number(target?.count || 0) !== counts[spec.name]) {
            const error = new Error(`Legacy import verification failed for '${spec.name}'.`);
            error.code = 'LEGACY_IMPORT_VERIFY_FAILED';
            throw error;
          }
        }
      });

      return { imported: true, reused: false, counts };
    } finally { source.close(); }
  }
}

module.exports = new LegacySqliteImportService();
module.exports.LegacySqliteImportService = LegacySqliteImportService;
module.exports.TABLES = TABLES;
