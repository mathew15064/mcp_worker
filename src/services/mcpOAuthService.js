const crypto = require('crypto');
const mcpConfig = require('../config/mcpConfig');
const mcpOAuthRepository = require('../repositories/mcpOAuthRepository');

class OAuthError extends Error {
  constructor(error, errorDescription, status = 400) {
    super(errorDescription || error);
    this.name = 'OAuthError';
    this.error = error;
    this.error_description = errorDescription || error;
    this.status = status;
  }
}

class McpOAuthService {
  constructor(repo = mcpOAuthRepository, config = mcpConfig) {
    this.repo = repo;
    this.config = config;
  }

  hash(data) {
    return crypto.createHash('sha256').update(String(data)).digest('hex');
  }

  timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  // ==========================================================================
  // Client Management
  // ==========================================================================

  async registerClient({ displayName, principalId, profileId = null, ownerUserId = null, redirectUris = [], allowedScopes = [] }) {
    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      throw new OAuthError('invalid_client_metadata', 'Client display name is required.');
    }
    const rawClientId = `br_client_${crypto.randomBytes(16).toString('hex')}`;
    if (ownerUserId && (!principalId || typeof principalId !== 'string' || !principalId.trim())) {
      throw new OAuthError('invalid_client_metadata', 'User-owned clients require a user principal identity.');
    }

    const normalizedPid = principalId && typeof principalId === 'string' && principalId.trim()
      ? principalId.trim()
      : `principal:client:${rawClientId}`;
    if (normalizedPid === 'principal:owner' || normalizedPid === 'OWNER' ||
        normalizedPid === 'principal:system' || normalizedPid === 'SYSTEM') {
      throw new OAuthError(
        'unauthorized_client_identity',
        `Remote OAuth clients cannot be mapped to '${normalizedPid}'. Owner and System identities require direct human web authorization.`
      );
    }
    if (!ownerUserId && normalizedPid.startsWith('principal:user:')) {
      throw new OAuthError('unauthorized_client_identity', 'User principal identities can only be assigned through a user-owned client profile.');
    }
    if (ownerUserId && !normalizedPid.startsWith('principal:user:')) {
      throw new OAuthError('invalid_client_metadata', 'User-owned clients require a user principal identity.');
    }

    const uris = Array.isArray(redirectUris) ? redirectUris : [redirectUris];
    const cleanedUris = uris.map(u => String(u).trim()).filter(Boolean);
    if (cleanedUris.length === 0) {
      throw new OAuthError('invalid_client_metadata', 'At least one valid redirect URI is required.');
    }
    for (const uri of cleanedUris) {
      try {
        const parsed = new URL(uri);
        if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
          throw new Error('Redirect URI must use HTTPS (or localhost for local development)');
        }
      } catch (err) {
        throw new OAuthError('invalid_client_metadata', `Invalid redirect URI '${uri}': ${err.message}`);
      }
    }

    const scopes = Array.isArray(allowedScopes) ? allowedScopes : [allowedScopes];
    const cleanedScopes = scopes.filter(s => this.config.supportedScopes.includes(s));
    if (cleanedScopes.length === 0) {
      cleanedScopes.push('bot_report.read', 'bot_report.terminal');
    }

    const rawClientSecret = `br_sec_${crypto.randomBytes(32).toString('base64url')}`;
    const resolvedProfileId = String(profileId || `prof_${crypto.randomBytes(12).toString('hex')}`).trim();
    const secretHash = this.hash(rawClientSecret);

    const client = await this.repo.createClient({
      clientId: rawClientId,
      clientSecretHash: secretHash,
      displayName: displayName.trim(),
      principalId: normalizedPid,
      profileId: resolvedProfileId,
      ownerUserId,
      redirectUris: cleanedUris,
      allowedScopes: cleanedScopes,
      status: 'active'
    });

    return {
      client,
      rawSecret: rawClientSecret
    };
  }

  async rotateClientSecret(clientId) {
    const client = await this.repo.findClientByClientId(clientId);
    if (!client) {
      throw new OAuthError('invalid_client', `Client '${clientId}' not found.`, 404);
    }

    const rawClientSecret = `br_sec_${crypto.randomBytes(32).toString('base64url')}`;
    const newSecretHash = this.hash(rawClientSecret);
    await this.repo.updateClientSecret(client.id, newSecretHash);

    const updatedClient = await this.repo.findClientById(client.id);
    return {
      client: updatedClient,
      rawSecret: rawClientSecret
    };
  }

  async authenticateClient(clientId, clientSecret) {
    if (!clientId || !clientSecret) {
      throw new OAuthError('invalid_client', 'Client ID and Client Secret are required.', 401);
    }

    const client = await this.repo.findClientByClientId(clientId);
    if (!client) {
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    }

    if (client.status !== 'active') {
      throw new OAuthError('invalid_client', `Client '${clientId}' is ${client.status}.`, 401);
    }
    if (client.owner_user_id && client.owner_user_status !== 'active') {
      throw new OAuthError('invalid_client', 'The mcp_worker user that owns this client is disabled.', 401);
    }

    const candidateHash = this.hash(clientSecret);
    if (!this.timingSafeCompare(candidateHash, client.client_secret_hash)) {
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    }

    return client;
  }

  // ==========================================================================
  // Authorization Code Flow
  // ==========================================================================

  async validateAuthorizeRequest({
    clientId,
    redirectUri,
    responseType,
    scope,
    state,
    codeChallenge,
    codeChallengeMethod,
    resource
  }) {
    if (!clientId) {
      throw new OAuthError('invalid_request', 'Missing required parameter: client_id');
    }
    const client = await this.repo.findClientByClientId(clientId);
    if (!client) {
      throw new OAuthError('invalid_client', `Unknown client_id: '${clientId}'`);
    }
    if (client.status !== 'active') {
      throw new OAuthError('unauthorized_client', `Client '${clientId}' is disabled or revoked.`);
    }
    if (client.owner_user_id && client.owner_user_status !== 'active') {
      throw new OAuthError('unauthorized_client', 'The mcp_worker user that owns this client is disabled.');
    }

    if (!redirectUri) {
      throw new OAuthError('invalid_request', 'Missing required parameter: redirect_uri');
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      throw new OAuthError('invalid_request', `redirect_uri does not match client allowlist.`);
    }

    if (responseType !== 'code') {
      throw new OAuthError('unsupported_response_type', `response_type must be 'code'. Got '${responseType}'`);
    }

    if (!codeChallenge) {
      throw new OAuthError('invalid_request', 'Missing required PKCE parameter: code_challenge');
    }
    if (codeChallengeMethod !== 'S256') {
      throw new OAuthError('invalid_request', `code_challenge_method must be 'S256'. 'plain' is forbidden.`);
    }

    const canonicalResource = this.config.resourceUrl;
    if (!resource) {
      throw new OAuthError('invalid_target', 'Missing required parameter: resource');
    }
    if (resource !== canonicalResource) {
      throw new OAuthError('invalid_target', `Requested resource '${resource}' does not match canonical resource '${canonicalResource}'`);
    }

    let requestedScopes = [];
    if (typeof scope === 'string') {
      requestedScopes = scope.trim().split(/\s+/).filter(Boolean);
    }
    if (requestedScopes.length === 0) {
      requestedScopes = ['bot_report.read', 'bot_report.terminal'];
    }

    const allowedScopes = requestedScopes.filter(s => client.allowed_scopes.includes(s));
    if (allowedScopes.length === 0) {
      throw new OAuthError('invalid_scope', 'None of the requested scopes are permitted for this client.');
    }

    return {
      client,
      redirectUri,
      resource: canonicalResource,
      scopes: allowedScopes,
      codeChallenge,
      codeChallengeMethod,
      state: state || null
    };
  }

  async issueAuthorizationCode({
    clientId,
    userId,
    principalId,
    redirectUri,
    resource,
    scopes = [],
    codeChallenge,
    codeChallengeMethod = 'S256'
  }) {
    const rawCode = `br_code_${crypto.randomBytes(32).toString('base64url')}`;
    const codeHash = this.hash(rawCode);
    const ttlSeconds = this.config.authCodeTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    await this.repo.createAuthCode({
      codeHash,
      clientId,
      userId,
      principalId,
      redirectUri,
      resource,
      scopes,
      codeChallenge,
      codeChallengeMethod,
      expiresAt
    });

    await this.repo.recordClientAuthorization(clientId);

    return rawCode;
  }

  async exchangeAuthorizationCode({
    clientId,
    clientSecret,
    code,
    redirectUri,
    resource,
    codeVerifier
  }) {
    const client = await this.authenticateClient(clientId, clientSecret);

    if (!code) {
      throw new OAuthError('invalid_request', 'Missing required parameter: code');
    }
    if (!codeVerifier) {
      throw new OAuthError('invalid_grant', 'Missing required PKCE parameter: code_verifier');
    }

    const codeHash = this.hash(code);
    const codeRecord = await this.repo.findAuthCodeByHash(codeHash);

    if (!codeRecord) {
      throw new OAuthError('invalid_grant', 'Invalid authorization code.');
    }
    if (codeRecord.used_at) {
      throw new OAuthError('invalid_grant', 'Authorization code has already been redeemed.');
    }
    if (new Date(codeRecord.expires_at).getTime() <= Date.now()) {
      throw new OAuthError('invalid_grant', 'Authorization code has expired.');
    }
    if (codeRecord.client_id !== clientId) {
      throw new OAuthError('invalid_grant', 'Authorization code was not issued to this client.');
    }
    if (codeRecord.redirect_uri !== redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match original authorization request.');
    }
    if (resource && codeRecord.resource !== resource) {
      throw new OAuthError('invalid_target', 'resource does not match original authorization request.');
    }

    const calculatedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    if (!this.timingSafeCompare(calculatedChallenge, codeRecord.code_challenge)) {
      throw new OAuthError('invalid_grant', 'PKCE code_verifier verification failed.');
    }

    const rawAccessToken = `br_at_${crypto.randomBytes(32).toString('base64url')}`;
    const accessTokenHash = this.hash(rawAccessToken);
    const accessTtl = this.config.accessTokenTtlSeconds;
    const accessExpiresAt = new Date(Date.now() + accessTtl * 1000).toISOString();

    const accessTokenData = {
      tokenHash: accessTokenHash,
      clientId: client.client_id,
      principalId: client.principal_id,
      resource: codeRecord.resource,
      scopes: codeRecord.scopes,
      expiresAt: accessExpiresAt
    };

    let rawRefreshToken = null;
    let refreshTokenData = null;
    if (codeRecord.scopes.includes('offline_access')) {
      rawRefreshToken = `br_rt_${crypto.randomBytes(32).toString('base64url')}`;
      const refreshTokenHash = this.hash(rawRefreshToken);
      const tokenFamilyId = `fam_${crypto.randomUUID()}`;
      const refreshTtl = this.config.refreshTokenTtlSeconds;
      const refreshExpiresAt = new Date(Date.now() + refreshTtl * 1000).toISOString();

      refreshTokenData = {
        tokenHash: refreshTokenHash,
        tokenFamilyId,
        clientId: client.client_id,
        principalId: client.principal_id,
        resource: codeRecord.resource,
        scopes: codeRecord.scopes,
        expiresAt: refreshExpiresAt
      };
    }

    try {
      await this.repo.consumeAuthCodeAndIssueTokens({
        codeId: codeRecord.id,
        accessToken: accessTokenData,
        refreshToken: refreshTokenData
      });
    } catch (err) {
      if (err.message === 'CONCURRENT_CONSUMPTION') {
        throw new OAuthError('invalid_grant', 'Authorization code has already been redeemed.');
      }
      throw err;
    }

    return {
      access_token: rawAccessToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
      refresh_token: rawRefreshToken || undefined,
      scope: codeRecord.scopes.join(' ')
    };
  }

  // ==========================================================================
  // Refresh Token Flow with Rotation and Reuse Detection
  // ==========================================================================

  async exchangeRefreshToken({
    clientId,
    clientSecret,
    refreshToken,
    scope = null,
    resource = null
  }) {
    const client = await this.authenticateClient(clientId, clientSecret);

    if (!refreshToken) {
      throw new OAuthError('invalid_request', 'Missing required parameter: refresh_token');
    }

    const tokenHash = this.hash(refreshToken);
    const refreshRecord = await this.repo.findRefreshTokenByHash(tokenHash);

    if (!refreshRecord) {
      throw new OAuthError('invalid_grant', 'Invalid refresh token.');
    }
    if (refreshRecord.client_id !== clientId) {
      throw new OAuthError('invalid_grant', 'Refresh token was not issued to this client.');
    }

    if (refreshRecord.replaced_by_hash || refreshRecord.revoked_at) {
      await this.repo.revokeTokenFamily(refreshRecord.token_family_id);
      throw new OAuthError('invalid_grant', 'Refresh token has already been used. Compromised token family revoked.');
    }

    if (new Date(refreshRecord.expires_at).getTime() <= Date.now()) {
      throw new OAuthError('invalid_grant', 'Refresh token has expired.');
    }

    if (resource && refreshRecord.resource !== resource) {
      throw new OAuthError('invalid_target', 'resource does not match original token grant.');
    }

    let grantedScopes = refreshRecord.scopes;
    if (scope) {
      const requested = scope.trim().split(/\s+/).filter(Boolean);
      for (const s of requested) {
        if (!refreshRecord.scopes.includes(s)) {
          throw new OAuthError('invalid_scope', `Cannot expand scope '${s}' during token refresh.`);
        }
      }
      grantedScopes = requested;
    }

    const rawNewRefreshToken = `br_rt_${crypto.randomBytes(32).toString('base64url')}`;
    const newRefreshTokenHash = this.hash(rawNewRefreshToken);
    const refreshTtl = this.config.refreshTokenTtlSeconds;
    const newRefreshExpiresAt = new Date(Date.now() + refreshTtl * 1000).toISOString();

    const rawNewAccessToken = `br_at_${crypto.randomBytes(32).toString('base64url')}`;
    const newAccessTokenHash = this.hash(rawNewAccessToken);
    const accessTtl = this.config.accessTokenTtlSeconds;
    const newAccessExpiresAt = new Date(Date.now() + accessTtl * 1000).toISOString();

    try {
      await this.repo.rotateRefreshTokenAndIssueAccess({
        currentTokenHash: tokenHash,
        replacementRefreshToken: {
          tokenHash: newRefreshTokenHash,
          tokenFamilyId: refreshRecord.token_family_id,
          clientId: client.client_id,
          principalId: client.principal_id,
          resource: refreshRecord.resource,
          scopes: grantedScopes,
          expiresAt: newRefreshExpiresAt
        },
        accessToken: {
          tokenHash: newAccessTokenHash,
          clientId: client.client_id,
          principalId: client.principal_id,
          resource: refreshRecord.resource,
          scopes: grantedScopes,
          expiresAt: newAccessExpiresAt
        }
      });
    } catch (err) {
      if (err.message === 'CONCURRENT_REFRESH_ROTATION') {
        throw new OAuthError('invalid_grant', 'Refresh token was already rotated by another request.');
      }
      throw err;
    }

    return {
      access_token: rawNewAccessToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
      refresh_token: rawNewRefreshToken,
      scope: grantedScopes.join(' ')
    };
  }

  // ==========================================================================
  // Token Revocation (RFC 7009)
  // ==========================================================================

  async revokeToken({ clientId, clientSecret, token, tokenTypeHint = null }) {
    await this.authenticateClient(clientId, clientSecret);

    if (!token) {
      throw new OAuthError('invalid_request', 'Missing required parameter: token');
    }

    const tokenHash = this.hash(token);

    if (tokenTypeHint === 'refresh_token') {
      const rf = await this.repo.findRefreshTokenByHash(tokenHash);
      if (rf && rf.client_id === clientId) {
        await this.repo.revokeRefreshToken(tokenHash);
      }
    } else if (tokenTypeHint === 'access_token') {
      const at = await this.repo.findAccessTokenByHash(tokenHash);
      if (at && at.client_id === clientId) {
        await this.repo.revokeAccessToken(tokenHash);
      }
    } else {
      await this.repo.revokeAccessToken(tokenHash);
      await this.repo.revokeRefreshToken(tokenHash);
    }

    return true;
  }
}

module.exports = new McpOAuthService();
module.exports.McpOAuthService = McpOAuthService;
module.exports.OAuthError = OAuthError;
