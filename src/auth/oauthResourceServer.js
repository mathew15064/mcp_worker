const crypto = require('crypto');
const { AuthenticatedPrincipal, SCOPES } = require('./principal');
const mcpConfig = require('../config/mcpConfig');

class AuthenticationError extends Error {
  constructor(message, status = 401, code = 'UNAUTHORIZED') {
    super(message);
    this.name = 'AuthenticationError';
    this.status = status;
    this.code = code;
  }
}

const STATIC_FIXTURES = Object.freeze({
  'token:mcp': {
    principalId: 'principal:test_mcp',
    actorId: 'principal:test_mcp',
    scopes: [SCOPES.READ, SCOPES.TERMINAL]
  },
  'token:read_only': {
    principalId: 'principal:read_only',
    actorId: 'principal:read_only',
    scopes: [SCOPES.READ]
  }
});

class OAuthResourceServer {
  constructor(options = {}) {
    this.repo = options.repo || null;
    if (typeof options.allowTestFixtures === 'boolean') this._explicitAllowTestFixtures = options.allowTestFixtures;
  }

  get allowTestFixtures() {
    if (process.env.NODE_ENV === 'production') return false;
    if (this._explicitAllowTestFixtures !== undefined) return this._explicitAllowTestFixtures;
    return process.env.NODE_ENV === 'test' && process.env.MCP_ALLOW_TEST_FIXTURES === 'true';
  }

  repository() {
    return this.repo || require('../repositories/mcpOAuthRepository');
  }

  extractBearerToken(authHeader) {
    if (!authHeader || typeof authHeader !== 'string') {
      throw new AuthenticationError('Missing Authorization header', 401, 'MISSING_AUTHORIZATION_HEADER');
    }
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1]) {
      throw new AuthenticationError('Malformed Authorization header. Expected: Bearer <token>', 401, 'INVALID_TOKEN_FORMAT');
    }
    return parts[1];
  }

  async verifyToken(token) {
    if (!token || typeof token !== 'string') {
      throw new AuthenticationError('Token must be a non-empty string', 401, 'INVALID_TOKEN');
    }

    if (this.allowTestFixtures && STATIC_FIXTURES[token]) {
      const fixture = STATIC_FIXTURES[token];
      return new AuthenticatedPrincipal({
        principalId: fixture.principalId,
        actorId: fixture.actorId,
        scopes: fixture.scopes,
        rawToken: token
      });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = await this.repository().findAccessTokenByHash(tokenHash);
    if (!record) throw new AuthenticationError('Invalid access token', 401, 'INVALID_TOKEN');
    if (record.revoked_at) throw new AuthenticationError('Access token has been revoked', 401, 'REVOKED_TOKEN');
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      throw new AuthenticationError('Access token has expired', 401, 'TOKEN_EXPIRED');
    }
    if (record.client_status !== 'active') {
      throw new AuthenticationError('OAuth client is disabled or revoked', 401, 'CLIENT_DISABLED');
    }
    if (record.owner_user_id && record.owner_user_status !== 'active') {
      throw new AuthenticationError('OAuth client owner is disabled', 401, 'USER_DISABLED');
    }
    if (record.resource !== mcpConfig.resourceUrl) {
      throw new AuthenticationError('Access token is not valid for this MCP resource', 401, 'INVALID_RESOURCE');
    }

    try { await this.repository().recordAccessTokenUsage(record.id); } catch (_) {}

    const principal = new AuthenticatedPrincipal({
      principalId: record.principal_id,
      actorId: record.principal_id,
      scopes: record.scopes,
      rawToken: token,
      clientId: record.client_id,
      profileId: record.profile_id || null,
      ownerUserId: record.owner_user_id || null
    });
    principal.client_name = record.client_name || null;
    return principal;
  }

  verifyTokenAsync(token) {
    return this.verifyToken(token);
  }

  createMiddleware() {
    return async (req, res, next) => {
      try {
        const token = this.extractBearerToken(req.headers.authorization);
        req.principal = await this.verifyTokenAsync(token);
        next();
      } catch (error) {
        if (res.headersSent) return;
        let challenge = `Bearer resource_metadata="${mcpConfig.metadataUrls.protectedResourceMcp}"`;
        if (['TOKEN_EXPIRED', 'INVALID_TOKEN', 'REVOKED_TOKEN', 'INVALID_TOKEN_FORMAT', 'CLIENT_DISABLED', 'USER_DISABLED', 'INVALID_RESOURCE'].includes(error.code)) {
          challenge += `, error="invalid_token"`;
        }
        res.setHeader('WWW-Authenticate', challenge);
        res.status(error.status || 401).json({
          error: 'Unauthorized',
          code: error.code || 'UNAUTHORIZED',
          message: error.message
        });
      }
    };
  }
}

module.exports = new OAuthResourceServer();
module.exports.OAuthResourceServer = OAuthResourceServer;
module.exports.AuthenticationError = AuthenticationError;
module.exports.STATIC_FIXTURES = STATIC_FIXTURES;
