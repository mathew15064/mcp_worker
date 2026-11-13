import databaseManager from '../db/databaseManager';
import type { DatabaseAdapter } from '../db/contracts';

import { canonicalRailwayOrigin } from '../config/railwayOrigin';

const DEFAULTS = Object.freeze({
  'mcp.enabled': process.env.MCP_ENABLED !== 'false' ? 'true' : 'false',
  'mcp.public_base_url': String(
    process.env.MCP_PUBLIC_BASE_URL ||
      (process.env.MCP_PLATFORM === 'railway'
        ? canonicalRailwayOrigin() || 'http://localhost:3333'
        : 'http://localhost:3333'),
  ).replace(/\/+$/, ''),
  'mcp.access_token_ttl_seconds': String(
    parseInt(process.env.MCP_ACCESS_TOKEN_TTL_SECONDS || '900', 10),
  ),
  'mcp.refresh_token_ttl_seconds': String(
    parseInt(process.env.MCP_REFRESH_TOKEN_TTL_SECONDS || '2592000', 10),
  ),
  'mcp.auth_code_ttl_seconds': String(parseInt(process.env.MCP_AUTH_CODE_TTL_SECONDS || '300', 10)),
  'mcp.rate_limit_per_minute': String(parseInt(process.env.MCP_RATE_LIMIT_PER_MINUTE || '120', 10)),
  'telegram.enabled': 'false',
  'telegram.chat_id': '',
  'telegram.bot_token': '',
});

class RuntimeSettingsService {
  values: Map<string, string>;
  loaded: boolean;
  constructor() {
    this.values = new Map(Object.entries(DEFAULTS));
    this.loaded = false;
  }

  async load(adapter: DatabaseAdapter | null = null) {
    const db = adapter || databaseManager.getAdapter();
    this.values = new Map(Object.entries(DEFAULTS));
    if (!db) {
      this.loaded = true;
      return this.snapshot();
    }
    try {
      const rows = await db.queryAll('SELECT `key`, `value` FROM system_settings');
      for (const row of rows) this.values.set(String(row.key), String(row.value ?? ''));
    } catch (_) {
      // Legacy DBs created before settings are initialized may not have the table yet.
    }
    this.loaded = true;
    return this.snapshot();
  }

  get(key: string, fallback = '') {
    return this.values.has(key) ? this.values.get(key)! : fallback;
  }

  bool(key: string, fallback = false) {
    const value = this.get(key, fallback ? 'true' : 'false');
    return value === 'true' || value === '1';
  }

  int(key: string, fallback: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const value = Number.parseInt(this.get(key, String(fallback)), 10);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  }

  async set(key: string, value: unknown, adapter: DatabaseAdapter | null = null) {
    const db = adapter || databaseManager.requireAdapter();
    const now = new Date().toISOString();
    if (db.kind === 'mysql') {
      await db.execute(
        `INSERT INTO system_settings (\`key\`, \`value\`, updated_at)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = VALUES(updated_at)`,
        [key, String(value ?? ''), now],
      );
    } else {
      await db.execute(
        `INSERT INTO system_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, String(value ?? ''), now],
      );
    }
    this.values.set(key, String(value ?? ''));
  }

  async setMany(entries: Record<string, unknown>, adapter: DatabaseAdapter | null = null) {
    const db = adapter || databaseManager.requireAdapter();
    for (const [key, value] of Object.entries(entries)) await this.set(key, value, db);
    return this.snapshot();
  }

  async seedDefaults(adapter: DatabaseAdapter | null = null) {
    const db = adapter || databaseManager.requireAdapter();
    let rows: { key: string }[] = [];
    try {
      rows = await db.queryAll<{ key: string }>('SELECT `key` FROM system_settings');
    } catch (_) {}
    const existing = new Set(rows.map((row) => String(row.key)));
    const currentBase = String(
      (process.env.MCP_PLATFORM === 'railway'
        ? canonicalRailwayOrigin()
        : process.env.MCP_PUBLIC_BASE_URL) || DEFAULTS['mcp.public_base_url'],
    ).replace(/\/+$/, '');
    const seed = { ...DEFAULTS, 'mcp.public_base_url': currentBase };
    for (const [key, value] of Object.entries(seed)) {
      if (!existing.has(key)) await this.set(key, value, db);
    }
    await this.load(db);
  }

  snapshot() {
    return Object.fromEntries(this.values.entries());
  }

  resetForTests() {
    this.values = new Map(Object.entries(DEFAULTS));
    this.loaded = false;
  }
}

const instance = Object.assign(new RuntimeSettingsService(), { RuntimeSettingsService, DEFAULTS });
export = instance;
