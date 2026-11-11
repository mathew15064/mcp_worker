import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './connection';
import type Database from 'better-sqlite3';

function columns(db: Database.Database, table: string) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => (row as {name: string}).name)); }
  catch (_) { return new Set(); }
}

function addColumnIfMissing(db: Database.Database, table: string, name: string, definition: string) {
  const names = columns(db, table);
  if (names.size && !names.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export function runMigrations(db: Database.Database | null = null) {
  const database = db || getDb();
  database.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  addColumnIfMissing(database, 'users', 'email', 'TEXT');
  addColumnIfMissing(database, 'users', 'display_name', 'TEXT');
  addColumnIfMissing(database, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(database, 'users', 'principal_id', 'TEXT');
  addColumnIfMissing(database, 'users', 'profile_id', 'TEXT');
  addColumnIfMissing(database, 'users', 'session_version', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(database, 'users', 'last_login_at', 'TEXT');
  addColumnIfMissing(database, 'terminal_profiles', 'host_key_fingerprint', 'TEXT');
  addColumnIfMissing(database, 'mcp_oauth_clients', 'profile_id', "TEXT NOT NULL DEFAULT 'legacy_profile'");
  addColumnIfMissing(database, 'mcp_oauth_clients', 'owner_user_id', 'TEXT');
  addColumnIfMissing(database, 'mcp_oauth_clients', 'last_authorized_at', 'TEXT');
  addColumnIfMissing(database, 'workers', 'owner_user_id', 'TEXT');
  addColumnIfMissing(database, 'worker_enrollment_tokens', 'owner_user_id', 'TEXT');
  addColumnIfMissing(database, 'mcp_oauth_access_tokens', 'last_used_at', 'TEXT');
  addColumnIfMissing(database, 'mcp_oauth_refresh_tokens', 'last_used_at', 'TEXT');
  addColumnIfMissing(database, 'mcp_oauth_refresh_tokens', 'replaced_by_hash', 'TEXT');
  addColumnIfMissing(database, 'mcp_request_audit', 'request_payload', 'TEXT');
  addColumnIfMissing(database, 'mcp_request_audit', 'response_payload', 'TEXT');
  addColumnIfMissing(database, 'mcp_request_audit', 'request_truncated', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(database, 'mcp_request_audit', 'response_truncated', 'INTEGER NOT NULL DEFAULT 0');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_principal_unique ON users(principal_id) WHERE principal_id IS NOT NULL');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_profile_unique ON users(profile_id) WHERE profile_id IS NOT NULL');
  database.exec('CREATE INDEX IF NOT EXISTS idx_mcp_clients_owner_user ON mcp_oauth_clients(owner_user_id)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_workers_owner_user ON workers(owner_user_id)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_worker_enrollment_owner_user ON worker_enrollment_tokens(owner_user_id)');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_profiles_name_nocase ON terminal_profiles(name COLLATE NOCASE)');
  return database;
}
