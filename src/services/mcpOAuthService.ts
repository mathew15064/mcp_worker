import crypto from 'node:crypto';
import mcpConfig from '../config/mcpConfig';
import mcpOAuthRepository from '../repositories/mcpOAuthRepository';
import userRepository from '../repositories/userRepository';
import type { OAuthConfig } from './contracts/oauthContracts';
import type { OAuthRepositoryContract } from './contracts/repositoryContracts';

interface RegisterInput {
  displayName: string;
  principalId?: string | null;
  profileId?: string | null;
  ownerUserId?: string | null;
  redirectUris?: string[] | string;
  allowedScopes?: string[] | string;
}
interface AuthorizeInput {
  clientId?: string;
  redirectUri?: string;
  responseType?: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
}
interface CodeInput {
  clientId: string;
  userId: string;
  principalId: string;
  redirectUri: string;
  resource: string;
  scopes?: string[];
  codeChallenge: string;
  codeChallengeMethod?: string;
}
interface ExchangeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  resource?: string | null;
  codeVerifier: string;
}
interface RefreshInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scope?: string | null;
  resource?: string | null;
}
interface RevokeInput {
  clientId: string;
  clientSecret: string;
  token: string;
  tokenTypeHint?: string | null;
}

class OAuthError extends Error {
  error: string;
  error_description: string;
  status: number;
  constructor(error: string, errorDescription: string | undefined = undefined, status = 400) {
    super(errorDescription || error);
    this.name = 'OAuthError';
    this.error = error;
    this.error_description = errorDescription || error;
    this.status = status;
  }
}

class McpOAuthService {
  repo: OAuthRepositoryContract;
  config: OAuthConfig;
  constructor(repo: OAuthRepositoryContract = mcpOAuthRepository, config: OAuthConfig = mcpConfig) {
    this.repo = repo;
    this.config = config;
  }

  hash(data: unknown) {
    return crypto.createHash('sha256').update(String(data)).digest('hex');
  }

  isSafeRedirectUri(uri: string) {
    try {
      // Check the original authority/fragment as URL normalization can erase
      // an empty userinfo or fragment marker.
      const authority = /^https?:\/\/([^/?#]*)/i.exec(uri)?.[1];
      if (!authority || authority.includes('@') || uri.includes('#')) return false;
      const parsed = new URL(uri);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      return (
        (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  }

  timingSafeCompare(a: unknown, b: unknown) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  // ==========================================================================
  // Client Management
  // ==========================================================================

  async registerPublicClient({ clientName, redirectUris, scope }: {
    clientName: string; redirectUris: string[]; scope?: string;
  }) {
    if (typeof clientName !== 'string' || !clientName.trim() || clientName.length > 100) {
      throw new OAuthError('invalid_client_metadata', 'Client name must be 1-100 characters.');
    }
    if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > 5 ||
      redirectUris.some(uri => typeof uri !== 'string' || uri.length > 2048 || !this.isSafeRedirectUri(uri))) {
      throw new OAuthError('invalid_redirect_uri', 'Between 1 and 5 valid HTTPS redirect URIs are required.');
    }
    if (new Set(redirectUris).size !== redirectUris.length)
      throw new OAuthError('invalid_redirect_uri', 'Duplicate redirect URIs are not allowed.');
    const scopes = typeof scope === 'string' && scope.trim() ? scope.trim().split(/\s+/) : ['mcp_worker.read', 'offline_access'];
    if (scopes.some(s => !['mcp_worker.read', 'offline_access'].includes(s)))
      throw new OAuthError('invalid_scope', 'Public clients support read and offline_access only.');
    if (!scopes.includes('mcp_worker.read')) scopes.unshift('mcp_worker.read');
    const id = 'br_public_' + crypto.randomBytes(16).toString('hex');
    const client = await this.repo.createClient({
      clientId: id,
      clientSecretHash: this.hash(crypto.randomBytes(32)),
      isPublic: true,
      displayName: clientName.trim(),
      principalId: 'principal:public:' + id,
      profileId: 'profile:public:' + id,
      ownerUserId: null,
      redirectUris,
      allowedScopes: scopes,
    });
    return {client, clientId:id, scopes};
  }

  async registerClient({
    displayName,
    principalId,
    profileId = null,
    ownerUserId = null,
    redirectUris = [],
    allowedScopes = [],
  }: RegisterInput) {
    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      throw new OAuthError('invalid_client_metadata', 'Client display name is required.');
    }
    const rawClientId = `br_client_${crypto.randomBytes(16).toString('hex')}`;
    if (ownerUserId && (!principalId || typeof principalId !== 'string' || !principalId.trim())) {
      throw new OAuthError(
        'invalid_client_metadata',
        'User-owned clients require a user principal identity.',
      );
    }

    const normalizedPid =
      principalId && typeof principalId === 'string' && principalId.trim()
        ? principalId.trim()
        : `principal:client:${rawClientId}`;
    if (
      normalizedPid === 'principal:owner' ||
      normalizedPid === 'OWNER' ||
      normalizedPid === 'principal:system' ||
      normalizedPid === 'SYSTEM'
    ) {
      throw new OAuthError(
        'unauthorized_client_identity',
        `Remote OAuth clients cannot be mapped to '${normalizedPid}'. Owner and System identities require direct human web authorization.`,
      );
    }
    if (!ownerUserId && normalizedPid.startsWith('principal:user:')) {
      throw new OAuthError(
        'unauthorized_client_identity',
        'User principal identities can only be assigned through a user-owned client profile.',
      );
    }
    if (ownerUserId && !normalizedPid.startsWith('principal:user:')) {
      throw new OAuthError(
        'invalid_client_metadata',
        'User-owned clients require a user principal identity.',
      );
    }

    const uris = Array.isArray(redirectUris) ? redirectUris : [redirectUris];
    const cleanedUris = uris.map((u) => String(u).trim()).filter(Boolean);
    if (cleanedUris.length === 0) {
      throw new OAuthError(
        'invalid_client_metadata',
        'At least one valid redirect URI is required.',
      );
    }
    for (const uri of cleanedUris) {
      if (!this.isSafeRedirectUri(uri)) {
        throw new OAuthError(
          'invalid_client_metadata',
          `Invalid redirect URI '${uri}': use HTTPS (or HTTP loopback), without userinfo or fragments.`,
        );
      }
    }

    const scopes = Array.isArray(allowedScopes) ? allowedScopes : [allowedScopes];
    const cleanedScopes = scopes.filter((s) => this.config.supportedScopes.includes(s));
    if (cleanedScopes.length === 0) {
      cleanedScopes.push('mcp_worker.read');
    }

    const rawClientSecret = `br_sec_${crypto.randomBytes(32).toString('base64url')}`;
    const resolvedProfileId = String(
      profileId || `prof_${crypto.randomBytes(12).toString('hex')}`,
    ).trim();
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
      status: 'active',
    });

    return {
      client,
      rawSecret: rawClientSecret,
    };
  }

  async rotateClientSecret(clientId: string) {
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
      rawSecret: rawClientSecret,
    };
  }

  async authenticateClient(clientId: string, clientSecret: string) {
    if (!clientId) {
      throw new OAuthError('invalid_client', 'Client ID is required.', 401);
    }

    const client = await this.repo.findClientByClientId(clientId);
    if (!client) {
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    }

    if (client.status !== 'active') {
      throw new OAuthError('invalid_client', `Client '${clientId}' is ${client.status}.`, 401);
    }
    if (client.owner_user_id && client.owner_user_status !== 'active') {
      throw new OAuthError(
        'invalid_client',
        'The mcp_worker user that owns this client is disabled.',
        401,
      );
    }

    if (client.is_public) {
      if (clientSecret) throw new OAuthError('invalid_client', 'Public clients must not send a client secret.', 401);
      return client;
    }
    if (!clientSecret) throw new OAuthError('invalid_client', 'Client secret required.', 401);
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
    resource,
  }: AuthorizeInput) {
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
      throw new OAuthError(
        'unauthorized_client',
        'The mcp_worker user that owns this client is disabled.',
      );
    }

    if (!redirectUri) {
      throw new OAuthError('invalid_request', 'Missing required parameter: redirect_uri');
    }
    if (!this.isSafeRedirectUri(redirectUri) || !client.redirect_uris.includes(redirectUri)) {
      throw new OAuthError('invalid_request', 'redirect_uri is unsafe or not allowlisted.');
    }

    if (responseType !== 'code') {
      throw new OAuthError(
        'unsupported_response_type',
        `response_type must be 'code'. Got '${responseType}'`,
      );
    }

    if (!codeChallenge) {
      throw new OAuthError('invalid_request', 'Missing required PKCE parameter: code_challenge');
    }
    if (codeChallengeMethod !== 'S256') {
      throw new OAuthError(
        'invalid_request',
        `code_challenge_method must be 'S256'. 'plain' is forbidden.`,
      );
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      throw new OAuthError('invalid_request', 'Invalid PKCE S256 code_challenge.');
    }

    const canonicalResource = this.config.resourceUrl;
    if (!resource) {
      throw new OAuthError('invalid_target', 'Missing required parameter: resource');
    }
    if (resource !== canonicalResource) {
      throw new OAuthError(
        'invalid_target',
        `Requested resource '${resource}' does not match canonical resource '${canonicalResource}'`,
      );
    }

    let requestedScopes: string[] = [];
    if (typeof scope === 'string') {
      requestedScopes = scope.trim().split(/\s+/).filter(Boolean);
    }
    if (requestedScopes.length === 0) {
      requestedScopes = ['mcp_worker.read'];
    }

    const allowedScopes = requestedScopes.filter((s) => client.allowed_scopes.includes(s));
    if (allowedScopes.length === 0) {
      throw new OAuthError(
        'invalid_scope',
        'None of the requested scopes are permitted for this client.',
      );
    }

    return {
      client,
      redirectUri,
      resource: canonicalResource,
      scopes: allowedScopes,
      codeChallenge,
      codeChallengeMethod,
      state: state || null,
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
    codeChallengeMethod = 'S256',
  }: CodeInput) {
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
      expiresAt,
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
    codeVerifier,
  }: ExchangeInput) {
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
      throw new OAuthError(
        'invalid_grant',
        'redirect_uri does not match original authorization request.',
      );
    }
    if (resource && codeRecord.resource !== resource) {
      throw new OAuthError(
        'invalid_target',
        'resource does not match original authorization request.',
      );
    }

    const calculatedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    if (!this.timingSafeCompare(calculatedChallenge, codeRecord.code_challenge)) {
      throw new OAuthError('invalid_grant', 'PKCE code_verifier verification failed.');
    }

    if (client.is_public) {
      const owner = await userRepository.findById(codeRecord.user_id);
      if (!owner || owner.status !== 'active' || owner.principal_id !== codeRecord.principal_id) {
        throw new OAuthError('invalid_grant', 'The authorizing user is no longer active.');
      }
    }

    const rawAccessToken = `br_at_${crypto.randomBytes(32).toString('base64url')}`;
    const accessTokenHash = this.hash(rawAccessToken);
    const accessTtl = this.config.accessTokenTtlSeconds;
    const accessExpiresAt = new Date(Date.now() + accessTtl * 1000).toISOString();

    const accessTokenData = {
      tokenHash: accessTokenHash,
      clientId: client.client_id,
      principalId: client.is_public ? codeRecord.principal_id : client.principal_id,
      ownerUserId: client.is_public ? codeRecord.user_id : client.owner_user_id,
      resource: codeRecord.resource,
      scopes: codeRecord.scopes,
      expiresAt: accessExpiresAt,
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
        principalId: client.is_public ? codeRecord.principal_id : client.principal_id,
        ownerUserId: client.is_public ? codeRecord.user_id : client.owner_user_id,
        resource: codeRecord.resource,
        scopes: codeRecord.scopes,
        expiresAt: refreshExpiresAt,
      };
    }

    try {
      await this.repo.consumeAuthCodeAndIssueTokens({
        codeId: codeRecord.id,
        accessToken: accessTokenData,
        refreshToken: refreshTokenData,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'CONCURRENT_CONSUMPTION') {
        throw new OAuthError('invalid_grant', 'Authorization code has already been redeemed.');
      }
      throw err;
    }

    return {
      access_token: rawAccessToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
      refresh_token: rawRefreshToken || undefined,
      scope: codeRecord.scopes.join(' '),
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
    resource = null,
  }: RefreshInput) {
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
    if (client.is_public && (!refreshRecord.owner_user_id || refreshRecord.owner_user_status !== 'active')) {
      throw new OAuthError('invalid_grant', 'The authorizing user is no longer active.');
    }

    if (refreshRecord.replaced_by_hash || refreshRecord.revoked_at) {
      await this.repo.revokeTokenFamily(refreshRecord.token_family_id);
      throw new OAuthError(
        'invalid_grant',
        'Refresh token has already been used. Compromised token family revoked.',
      );
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
          principalId: client.is_public ? refreshRecord.principal_id : client.principal_id,
          ownerUserId: client.is_public ? refreshRecord.owner_user_id : client.owner_user_id,
          resource: refreshRecord.resource,
          scopes: grantedScopes,
          expiresAt: newRefreshExpiresAt,
        },
        accessToken: {
          tokenHash: newAccessTokenHash,
          clientId: client.client_id,
          principalId: client.is_public ? refreshRecord.principal_id : client.principal_id,
          ownerUserId: client.is_public ? refreshRecord.owner_user_id : client.owner_user_id,
          resource: refreshRecord.resource,
          scopes: grantedScopes,
          expiresAt: newAccessExpiresAt,
        },
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'CONCURRENT_REFRESH_ROTATION') {
        throw new OAuthError(
          'invalid_grant',
          'Refresh token was already rotated by another request.',
        );
      }
      throw err;
    }

    return {
      access_token: rawNewAccessToken,
      token_type: 'Bearer',
      expires_in: accessTtl,
      refresh_token: rawNewRefreshToken,
      scope: grantedScopes.join(' '),
    };
  }

  // ==========================================================================
  // Token Revocation (RFC 7009)
  // ==========================================================================

  async revokeToken({ clientId, clientSecret, token, tokenTypeHint = null }: RevokeInput) {
    await this.authenticateClient(clientId, clientSecret);

    if (!token) {
      throw new OAuthError('invalid_request', 'Missing required parameter: token');
    }

    const tokenHash = this.hash(token);

    // The storage-side UPDATE must include client_id. A lookup followed by
    // hash-only mutation is not an authorization boundary (TOCTOU), and an
    // unknown or omitted hint must never revoke another client's token.
    // This port is provided by T4's exclusive-owned repository implementation.
    type ClientBoundRevokePort = {
      revokeAccessTokenForClient: (hash: string, ownerClientId: string) => Promise<unknown>;
      revokeRefreshTokenForClient: (hash: string, ownerClientId: string) => Promise<unknown>;
    };
    const scoped = this.repo as OAuthRepositoryContract & Partial<ClientBoundRevokePort>;
    if (
      typeof scoped.revokeAccessTokenForClient !== 'function' ||
      typeof scoped.revokeRefreshTokenForClient !== 'function'
    ) {
      // Fail closed if the corresponding T4 repository patch is missing.
      throw new OAuthError('server_error', 'Client-scoped token revocation is unavailable.', 503);
    }

    if (tokenTypeHint === 'refresh_token') {
      await scoped.revokeRefreshTokenForClient(tokenHash, clientId);
    } else if (tokenTypeHint === 'access_token') {
      await scoped.revokeAccessTokenForClient(tokenHash, clientId);
    } else {
      // RFC 7009: an unknown hint is not proof of token type.
      await scoped.revokeAccessTokenForClient(tokenHash, clientId);
      await scoped.revokeRefreshTokenForClient(tokenHash, clientId);
    }

    return true;
  }
}

const instance = Object.assign(new McpOAuthService(), { McpOAuthService, OAuthError });
export = instance;
