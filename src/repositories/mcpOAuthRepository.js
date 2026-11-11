const crypto = require('crypto');
const databaseManager = require('../db/databaseManager');
const { SqliteAdapter } = require('../db/adapters/sqliteAdapter');

function hydrateScopes(row) {
  if (!row) return null;
  let scopes = [];
  try { scopes = JSON.parse(row.scopes_json || '[]'); } catch (_) {}
  return { ...row, scopes };
}

class McpOAuthRepository {
  constructor(db = null) { this._db = db && typeof db.prepare === 'function' ? new SqliteAdapter(db) : db; }
  get db() { return this._db || databaseManager.requireAdapter(); }

  _hydrateClient(row) {
    if (!row) return null;
    let redirectUris = [];
    let allowedScopes = [];
    try { redirectUris = JSON.parse(row.redirect_uris_json || '[]'); } catch (_) {}
    try { allowedScopes = JSON.parse(row.allowed_scopes_json || '[]'); } catch (_) {}
    return { ...row, redirect_uris: redirectUris, allowed_scopes: allowedScopes };
  }

  async createClient({ id = null, clientId, clientSecretHash, displayName, principalId, profileId, ownerUserId = null, redirectUris = [], allowedScopes = [], status = 'active' }) {
    const recordId = id || `client_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await this.db.execute(`INSERT INTO mcp_oauth_clients
      (id, client_id, client_secret_hash, display_name, principal_id, profile_id, owner_user_id, redirect_uris_json, allowed_scopes_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [recordId, clientId, clientSecretHash, displayName, principalId, profileId, ownerUserId || null,
      JSON.stringify(Array.isArray(redirectUris) ? redirectUris : [redirectUris]),
      JSON.stringify(Array.isArray(allowedScopes) ? allowedScopes : [allowedScopes]), status, now, now]);
    return this.findClientById(recordId);
  }

  async findClientByClientId(clientId) {
    if (!clientId) return null;
    return this._hydrateClient(await this.db.queryOne(`SELECT c.*, u.status AS owner_user_status
      FROM mcp_oauth_clients c LEFT JOIN users u ON u.id = c.owner_user_id WHERE c.client_id = ?`, [clientId]));
  }

  async findClientById(id) {
    if (!id) return null;
    return this._hydrateClient(await this.db.queryOne('SELECT * FROM mcp_oauth_clients WHERE id = ?', [id]));
  }

  async findClientByIdForOwner(id, ownerUserId) {
    if (!id || !ownerUserId) return null;
    return this._hydrateClient(await this.db.queryOne('SELECT * FROM mcp_oauth_clients WHERE id = ? AND owner_user_id = ?', [id, ownerUserId]));
  }

  async listClients() {
    return (await this.db.queryAll('SELECT * FROM mcp_oauth_clients ORDER BY created_at DESC')).map(row => this._hydrateClient(row));
  }

  async listClientsByOwner(ownerUserId) {
    if (!ownerUserId) return [];
    return (await this.db.queryAll('SELECT * FROM mcp_oauth_clients WHERE owner_user_id = ? ORDER BY created_at DESC', [ownerUserId])).map(row => this._hydrateClient(row));
  }

  async updateClientStatus(id, status) {
    return this.db.execute('UPDATE mcp_oauth_clients SET status = ?, updated_at = ? WHERE id = ?', [status, new Date().toISOString(), id]);
  }

  async updateClientSecret(id, newSecretHash) {
    return this.db.execute('UPDATE mcp_oauth_clients SET client_secret_hash = ?, updated_at = ? WHERE id = ?', [newSecretHash, new Date().toISOString(), id]);
  }

  async recordClientAuthorization(clientId) {
    const now = new Date().toISOString();
    return this.db.execute('UPDATE mcp_oauth_clients SET last_authorized_at = ?, updated_at = ? WHERE client_id = ?', [now, now, clientId]);
  }

  async deleteClient(id) {
    const client = await this.findClientById(id);
    if (!client) return { changes: 0 };
    return this.db.transaction(async tx => {
      const now = new Date().toISOString();
      await tx.execute('UPDATE mcp_oauth_access_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL', [now, client.client_id]);
      await tx.execute('UPDATE mcp_oauth_refresh_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL', [now, client.client_id]);
      return tx.execute('DELETE FROM mcp_oauth_clients WHERE id = ?', [id]);
    });
  }

  async createAuthCode({ id = null, codeHash, clientId, userId, principalId, redirectUri, resource, scopes = [], codeChallenge, codeChallengeMethod = 'S256', expiresAt }) {
    const recordId = id || `code_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await this.db.execute(`INSERT INTO mcp_oauth_authorization_codes
      (id, code_hash, client_id, user_id, principal_id, redirect_uri, resource, scopes_json, code_challenge, code_challenge_method, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [recordId, codeHash, clientId, userId, principalId, redirectUri, resource,
      JSON.stringify(Array.isArray(scopes) ? scopes : [scopes]), codeChallenge, codeChallengeMethod, expiresAt, now]);
    return this.findAuthCodeByHash(codeHash);
  }

  async findAuthCodeByHash(codeHash) {
    if (!codeHash) return null;
    return hydrateScopes(await this.db.queryOne('SELECT * FROM mcp_oauth_authorization_codes WHERE code_hash = ?', [codeHash]));
  }

  async markAuthCodeUsed(id) {
    return this.db.execute('UPDATE mcp_oauth_authorization_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [new Date().toISOString(), id]);
  }

  async consumeAuthCodeAndIssueTokens({ codeId, accessToken, refreshToken = null }) {
    const now = new Date().toISOString();
    return this.db.transaction(async tx => {
      const codeUpdate = await tx.execute('UPDATE mcp_oauth_authorization_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [now, codeId]);
      if (codeUpdate.changes === 0) throw new Error('CONCURRENT_CONSUMPTION');
      const accessTokenId = accessToken.id || `at_${crypto.randomUUID()}`;
      await tx.execute(`INSERT INTO mcp_oauth_access_tokens
        (id, token_hash, client_id, principal_id, resource, scopes_json, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [accessTokenId, accessToken.tokenHash, accessToken.clientId, accessToken.principalId,
        accessToken.resource, JSON.stringify(Array.isArray(accessToken.scopes) ? accessToken.scopes : [accessToken.scopes]), accessToken.expiresAt, now]);
      let refreshTokenId = null;
      if (refreshToken) {
        refreshTokenId = refreshToken.id || `rt_${crypto.randomUUID()}`;
        await tx.execute(`INSERT INTO mcp_oauth_refresh_tokens
          (id, token_hash, token_family_id, client_id, principal_id, resource, scopes_json, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [refreshTokenId, refreshToken.tokenHash, refreshToken.tokenFamilyId, refreshToken.clientId,
          refreshToken.principalId, refreshToken.resource, JSON.stringify(Array.isArray(refreshToken.scopes) ? refreshToken.scopes : [refreshToken.scopes]), refreshToken.expiresAt, now]);
      }
      return { accessTokenId, refreshTokenId };
    });
  }

  async createAccessToken({ id = null, tokenHash, clientId, principalId, resource, scopes = [], expiresAt }) {
    const recordId = id || `at_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await this.db.execute(`INSERT INTO mcp_oauth_access_tokens
      (id, token_hash, client_id, principal_id, resource, scopes_json, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [recordId, tokenHash, clientId, principalId, resource,
      JSON.stringify(Array.isArray(scopes) ? scopes : [scopes]), expiresAt, now]);
    return this.findAccessTokenByHash(tokenHash);
  }

  async findAccessTokenByHash(tokenHash) {
    if (!tokenHash) return null;
    return hydrateScopes(await this.db.queryOne(`SELECT t.*, c.status AS client_status, c.profile_id, c.display_name AS client_name,
      c.owner_user_id, u.status AS owner_user_status
      FROM mcp_oauth_access_tokens t
      JOIN mcp_oauth_clients c ON t.client_id = c.client_id
      LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE t.token_hash = ?`, [tokenHash]));
  }

  async revokeAccessToken(tokenHash) {
    return this.db.execute('UPDATE mcp_oauth_access_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [new Date().toISOString(), tokenHash]);
  }

  async revokeAccessTokensByClientId(clientId) {
    return this.db.execute('UPDATE mcp_oauth_access_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL', [new Date().toISOString(), clientId]);
  }

  async revokeAllTokensByClientId(clientId) {
    return this.db.transaction(async tx => {
      const now = new Date().toISOString();
      const access = await tx.execute('UPDATE mcp_oauth_access_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL', [now, clientId]);
      const refresh = await tx.execute('UPDATE mcp_oauth_refresh_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL', [now, clientId]);
      return { access_revoked: access.changes, refresh_revoked: refresh.changes };
    });
  }

  async recordAccessTokenUsage(id) {
    return this.db.execute('UPDATE mcp_oauth_access_tokens SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }

  async countActiveGrants() {
    const row = await this.db.queryOne(`SELECT COUNT(DISTINCT client_id) AS count FROM mcp_oauth_access_tokens
      WHERE revoked_at IS NULL AND expires_at > ?`, [new Date().toISOString()]);
    return Number(row?.count || 0);
  }

  async createRefreshToken({ id = null, tokenHash, tokenFamilyId, clientId, principalId, resource, scopes = [], expiresAt }) {
    const recordId = id || `rt_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await this.db.execute(`INSERT INTO mcp_oauth_refresh_tokens
      (id, token_hash, token_family_id, client_id, principal_id, resource, scopes_json, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [recordId, tokenHash, tokenFamilyId, clientId, principalId, resource,
      JSON.stringify(Array.isArray(scopes) ? scopes : [scopes]), expiresAt, now]);
    return this.findRefreshTokenByHash(tokenHash);
  }

  async findRefreshTokenByHash(tokenHash) {
    if (!tokenHash) return null;
    return hydrateScopes(await this.db.queryOne(`SELECT r.*, c.status AS client_status, c.profile_id, c.owner_user_id,
      u.status AS owner_user_status
      FROM mcp_oauth_refresh_tokens r
      JOIN mcp_oauth_clients c ON r.client_id = c.client_id
      LEFT JOIN users u ON u.id = c.owner_user_id
      WHERE r.token_hash = ?`, [tokenHash]));
  }

  async revokeRefreshToken(tokenHash, replacedByHash = null) {
    return this.db.execute(`UPDATE mcp_oauth_refresh_tokens SET revoked_at = ?, replaced_by_hash = ?
      WHERE token_hash = ? AND revoked_at IS NULL`, [new Date().toISOString(), replacedByHash, tokenHash]);
  }

  async revokeRefreshTokensByClientId(clientId) {
    return this.db.execute('UPDATE mcp_oauth_refresh_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL', [new Date().toISOString(), clientId]);
  }

  async revokeTokenFamily(tokenFamilyId) {
    return this.db.execute('UPDATE mcp_oauth_refresh_tokens SET revoked_at = ? WHERE token_family_id = ? AND revoked_at IS NULL', [new Date().toISOString(), tokenFamilyId]);
  }

  async rotateRefreshTokenAndIssueAccess({ currentTokenHash, replacementRefreshToken, accessToken }) {
    const now = new Date().toISOString();
    return this.db.transaction(async tx => {
      const rotated = await tx.execute(`UPDATE mcp_oauth_refresh_tokens SET revoked_at = ?, replaced_by_hash = ?
        WHERE token_hash = ? AND revoked_at IS NULL AND replaced_by_hash IS NULL`, [now, replacementRefreshToken.tokenHash, currentTokenHash]);
      if (rotated.changes !== 1) throw new Error('CONCURRENT_REFRESH_ROTATION');
      const refreshTokenId = replacementRefreshToken.id || `rt_${crypto.randomUUID()}`;
      await tx.execute(`INSERT INTO mcp_oauth_refresh_tokens
        (id, token_hash, token_family_id, client_id, principal_id, resource, scopes_json, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [refreshTokenId, replacementRefreshToken.tokenHash, replacementRefreshToken.tokenFamilyId,
        replacementRefreshToken.clientId, replacementRefreshToken.principalId, replacementRefreshToken.resource,
        JSON.stringify(Array.isArray(replacementRefreshToken.scopes) ? replacementRefreshToken.scopes : [replacementRefreshToken.scopes]), replacementRefreshToken.expiresAt, now]);
      const accessTokenId = accessToken.id || `at_${crypto.randomUUID()}`;
      await tx.execute(`INSERT INTO mcp_oauth_access_tokens
        (id, token_hash, client_id, principal_id, resource, scopes_json, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [accessTokenId, accessToken.tokenHash, accessToken.clientId, accessToken.principalId,
        accessToken.resource, JSON.stringify(Array.isArray(accessToken.scopes) ? accessToken.scopes : [accessToken.scopes]), accessToken.expiresAt, now]);
      return { refreshTokenId, accessTokenId };
    });
  }

  async recordRefreshTokenUsage(id) {
    return this.db.execute('UPDATE mcp_oauth_refresh_tokens SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), id]);
  }

  async recordAudit({ id = null, requestId, clientId = null, principalId = null, actorId = null, mcpMethod, toolName = null, result, httpStatus, durationMs,
    requestPayload = null, responsePayload = null, requestTruncated = false, responseTruncated = false }) {
    const recordId = id || `aud_${crypto.randomUUID()}`;
    return this.db.execute(`INSERT INTO mcp_request_audit
      (id, request_id, client_id, principal_id, actor_id, mcp_method, tool_name, result, http_status, duration_ms,
       request_payload, response_payload, request_truncated, response_truncated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [recordId, requestId, clientId, principalId, actorId, mcpMethod, toolName,
      result, httpStatus, durationMs, requestPayload, responsePayload, requestTruncated ? 1 : 0, responseTruncated ? 1 : 0, new Date().toISOString()]);
  }

  buildAuditFilter({ clientId = '', toolName = '', result = '', query = '' } = {}) {
    const clauses = [];
    const params = [];
    if (clientId) { clauses.push('a.client_id = ?'); params.push(clientId); }
    if (toolName) { clauses.push('a.tool_name = ?'); params.push(toolName); }
    if (result) { clauses.push('a.result = ?'); params.push(result); }
    if (query) {
      clauses.push(`(a.request_id LIKE ? OR a.mcp_method LIKE ? OR COALESCE(a.tool_name, '') LIKE ? OR
        COALESCE(a.client_id, '') LIKE ? OR COALESCE(a.principal_id, '') LIKE ? OR COALESCE(c.display_name, '') LIKE ?)`);
      const value = `%${query}%`;
      params.push(value, value, value, value, value, value);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  async listAuditLogs({ limit = 50, offset = 0, clientId = '', toolName = '', result = '', query = '' } = {}) {
    const filter = this.buildAuditFilter({ clientId, toolName, result, query });
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    return this.db.queryAll(`SELECT a.id, a.request_id, a.client_id, a.principal_id, a.actor_id, a.mcp_method, a.tool_name,
        a.result, a.http_status, a.duration_ms, a.request_truncated, a.response_truncated, a.created_at,
        c.display_name AS client_display_name
      FROM mcp_request_audit a LEFT JOIN mcp_oauth_clients c ON c.client_id = a.client_id
      ${filter.where} ORDER BY a.created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`, filter.params);
  }

  async findAuditLogById(id) {
    return this.db.queryOne(`SELECT a.*, c.display_name AS client_display_name
      FROM mcp_request_audit a LEFT JOIN mcp_oauth_clients c ON c.client_id = a.client_id
      WHERE a.id = ? LIMIT 1`, [id]);
  }

  async countAuditLogs({ clientId = '', toolName = '', result = '', query = '' } = {}) {
    const filter = this.buildAuditFilter({ clientId, toolName, result, query });
    const row = await this.db.queryOne(`SELECT COUNT(*) AS total FROM mcp_request_audit a
      LEFT JOIN mcp_oauth_clients c ON c.client_id = a.client_id ${filter.where}`, filter.params);
    return Number(row?.total || 0);
  }

  async hasAdminRuntimeCall() {
    const row = await this.db.queryOne(`SELECT a.id FROM mcp_request_audit a
      JOIN mcp_oauth_clients c ON c.client_id = a.client_id
      WHERE c.owner_user_id IS NULL AND c.status = 'active'
      AND a.mcp_method = 'tools/call' AND a.tool_name = 'runtime_info' AND a.result = 'SUCCESS'
      LIMIT 1`);
    return Boolean(row);
  }

  async listAuditToolNames() {
    const rows = await this.db.queryAll(`SELECT DISTINCT tool_name FROM mcp_request_audit
      WHERE tool_name IS NOT NULL AND tool_name <> '' ORDER BY tool_name ASC`);
    return rows.map(row => row.tool_name);
  }

  async getLastActivity() {
    const row = await this.db.queryOne('SELECT created_at FROM mcp_request_audit ORDER BY created_at DESC LIMIT 1');
    return row?.created_at || null;
  }
}

module.exports = new McpOAuthRepository();
module.exports.McpOAuthRepository = McpOAuthRepository;
