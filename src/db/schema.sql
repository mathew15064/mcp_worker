PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active',
  principal_id TEXT UNIQUE,
  profile_id TEXT UNIQUE,
  session_version INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expired INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
  username TEXT NOT NULL,
  credential_envelope TEXT NOT NULL,
  host_key_fingerprint TEXT,
  tmux_session TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_profiles_name_nocase ON terminal_profiles(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS terminal_connection_audit (
  id TEXT PRIMARY KEY,
  terminal_profile_id TEXT REFERENCES terminal_profiles(id) ON DELETE SET NULL,
  profile_name_snapshot TEXT NOT NULL,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terminal_audit_profile ON terminal_connection_audit(terminal_profile_id, created_at DESC);

-- Worker tables are used by the v2 outbound transport. This SQLite schema is
-- also the single-replica Railway production schema; changes must remain additive.
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  owner_user_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_name_nocase ON workers(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);

CREATE TABLE IF NOT EXISTS worker_enrollment_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_user_id TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_enrollment_expires ON worker_enrollment_tokens(expires_at);

CREATE TABLE IF NOT EXISTS worker_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  tmux_session TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_profiles_name_nocase ON worker_profiles(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_worker_profiles_worker ON worker_profiles(worker_id);

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  redirect_uris_json TEXT NOT NULL,
  allowed_scopes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_authorized_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_clients_status ON mcp_oauth_clients(status);

CREATE TABLE IF NOT EXISTS mcp_oauth_authorization_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK(code_challenge_method = 'S256'),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_codes_client ON mcp_oauth_authorization_codes(client_id);

CREATE TABLE IF NOT EXISTS mcp_oauth_access_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_access_tokens_client ON mcp_oauth_access_tokens(client_id);

CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by_hash TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_refresh_tokens_family ON mcp_oauth_refresh_tokens(token_family_id);
CREATE INDEX IF NOT EXISTS idx_mcp_refresh_tokens_client ON mcp_oauth_refresh_tokens(client_id);

CREATE TABLE IF NOT EXISTS mcp_request_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  client_id TEXT,
  principal_id TEXT,
  actor_id TEXT,
  mcp_method TEXT NOT NULL,
  tool_name TEXT,
  result TEXT NOT NULL CHECK(result IN ('SUCCESS', 'DENIED', 'ERROR')),
  http_status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  request_payload TEXT,
  response_payload TEXT,
  request_truncated INTEGER NOT NULL DEFAULT 0,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_created ON mcp_request_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_client ON mcp_request_audit(client_id);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_tool ON mcp_request_audit(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_result ON mcp_request_audit(result);
