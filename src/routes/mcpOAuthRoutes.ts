import express, {type Request} from 'express';
import {rateLimit} from 'express-rate-limit';
import mcpConfig = require('../config/mcpConfig');
import mcpOAuthService = require('../services/mcpOAuthService');
import mcpOAuthRepository = require('../repositories/mcpOAuthRepository');
import databaseManager = require('../db/databaseManager');
import authRoutes = require('./authRoutes');
const { currentIdentity } = authRoutes;
const {oauthConsentPage, errorPage}: {oauthConsentPage(data: Record<string, unknown>): string; errorPage(code: number, message: string): string} = require('../http/pages');
interface OAuthIdentity {id: string; role: string}
interface OwnedClient {owner_user_id: string | null}
function queryString(value: unknown): string | undefined {return typeof value === 'string' ? value : undefined;}
function oauthFailure(value: unknown): {status: number; error: string; message: string; description: string} {
  const e = value && typeof value === 'object' ? value as {status?: number; error?: string; message?: string; error_description?: string} : {};
  return {status: typeof e.status === 'number' ? e.status : 400, error: e.error || 'invalid_request', message: e.message || 'OAuth request failed', description: e.error_description || e.message || 'OAuth request failed'};
}


const router = express.Router();

router.use((req, res, next) => {
  if (!databaseManager.isOperational()) {
    return res.status(503).json({ error: 'temporarily_unavailable', error_description: 'Database is not configured or unavailable.', code: databaseManager.status().state });
  }
  if (!mcpConfig.enabled) return res.status(503).json({ error: 'temporarily_unavailable', error_description: 'MCP is disabled.', code: 'MCP_DISABLED' });
  next();
});

// Helper to determine if an authorization error can safely redirect
async function isSafeErrorRedirect(clientId: unknown, redirectUri: unknown) {
  if (typeof clientId !== 'string' || typeof redirectUri !== 'string') return false;
  try {
    const client = await mcpOAuthRepository.findClientByClientId(clientId);
    if (!client || client.status !== 'active') return false;
    return Array.isArray(client.redirect_uris) && client.redirect_uris.includes(redirectUri);
  } catch (_) {
    return false;
  }
}

function canAuthorizeClient(identity: OAuthIdentity | null, client: OwnedClient | null) {
  if (!identity || !client) return false;
  if (client.owner_user_id) return identity.role === 'user' && identity.id === client.owner_user_id;
  return identity.role === 'admin';
}

// Rate limiters for OAuth endpoints
const tokenRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => mcpConfig.rateLimitPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'slow_down', error_description: 'Too many requests. Please try again later.' }
});

const authorizeRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => mcpConfig.rateLimitPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'slow_down', error_description: 'Too many requests. Please try again later.' }
});


// Extract client credentials from Basic Auth or POST body
function extractClientCredentials(req: Request) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('basic ')) {
    const b64 = authHeader.substring(6).trim();
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx !== -1) {
        return {
          clientId: decodeURIComponent(decoded.substring(0, idx)),
          clientSecret: decodeURIComponent(decoded.substring(idx + 1))
        };
      }
    } catch (_) {}
  }

  const clientId = req.body?.client_id;
  const clientSecret = req.body?.client_secret;
  if (clientId && clientSecret) {
    return {
      clientId: String(clientId).trim(),
      clientSecret: String(clientSecret).trim()
    };
  }

  return null;
}

// ============================================================================
// Discovery Endpoints
// ============================================================================

// Canonical path-aware Protected Resource Metadata
router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    resource: mcpConfig.resourceUrl,
    authorization_servers: [
      mcpConfig.issuer
    ],
    scopes_supported: mcpConfig.supportedScopes,
    bearer_methods_supported: [
      'header'
    ],
    resource_name: 'mcp_worker Gateway'
  });
});

// Root Protected Resource Metadata for compatibility
router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    resource: mcpConfig.resourceUrl,
    authorization_servers: [
      mcpConfig.issuer
    ],
    scopes_supported: mcpConfig.supportedScopes,
    bearer_methods_supported: [
      'header'
    ],
    resource_name: 'mcp_worker Gateway'
  });
});

// OAuth 2.1 Authorization Server Metadata (RFC 8414)
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    issuer: mcpConfig.issuer,
    authorization_endpoint: mcpConfig.metadataUrls.authorizationEndpoint,
    token_endpoint: mcpConfig.metadataUrls.tokenEndpoint,
    revocation_endpoint: mcpConfig.metadataUrls.revocationEndpoint,

    response_types_supported: ['code'],
    grant_types_supported: [
      'authorization_code',
      'refresh_token'
    ],

    code_challenge_methods_supported: [
      'S256'
    ],

    token_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'client_secret_post'
    ],

    scopes_supported: mcpConfig.supportedScopes,

    authorization_response_iss_parameter_supported: true
  });
});

// ============================================================================
// Authorization Endpoint (/oauth/authorize)
// ============================================================================

router.get('/oauth/authorize', authorizeRateLimiter, async (req, res) => {
  try {
    const validated = await mcpOAuthService.validateAuthorizeRequest({
      clientId: queryString(req.query.client_id),
      redirectUri: queryString(req.query.redirect_uri),
      responseType: queryString(req.query.response_type),
      scope: queryString(req.query.scope),
      state: queryString(req.query.state),
      codeChallenge: queryString(req.query.code_challenge),
      codeChallengeMethod: queryString(req.query.code_challenge_method),
      resource: queryString(req.query.resource)
    });

    const user = await currentIdentity(req);
    if (!user) {
      if (req.session) req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    if (!canAuthorizeClient(user, validated.client)) {
      return res.status(403).type('html').send(errorPage(403, 'This OAuth client belongs to a different mcp_worker identity.'));
    }

    return res.type('html').send(oauthConsentPage({
      client: validated.client,
      redirectUri: validated.redirectUri,
      resource: validated.resource,
      scopes: validated.scopes,
      state: validated.state,
      codeChallenge: validated.codeChallenge,
      codeChallengeMethod: validated.codeChallengeMethod,
      csrfToken: req.session?.csrfToken || ''
    }));
  } catch (err) {
    const failure = oauthFailure(err);
    const rawClientId = queryString(req.query.client_id);
    const rawRedirectUri = queryString(req.query.redirect_uri);

    if (typeof rawRedirectUri === "string" && await isSafeErrorRedirect(rawClientId, rawRedirectUri)) {
      try {
        const u = new URL(rawRedirectUri);
        u.searchParams.set('error', failure.error);
        u.searchParams.set('error_description', failure.message);
        if (queryString(req.query.state)) u.searchParams.set('state', queryString(req.query.state)!);
        u.searchParams.set('iss', mcpConfig.issuer);
        return res.redirect(u.toString());
      } catch (_) {}
    }

    return res.status(failure.status).type('html').send(errorPage(failure.status, failure.message));
  }
});

router.post('/oauth/authorize', authorizeRateLimiter, async (req, res) => {
  const user = await currentIdentity(req);
  if (!user) {
    return res.status(403).type('html').send(errorPage(403, 'Authenticated mcp_worker session required to authorize MCP client.'));
  }

  const {
    client_id,
    redirect_uri,
    scope,
    state,
    code_challenge,
    code_challenge_method,
    resource,
    action
  } = req.body;

  try {
    const validated = await mcpOAuthService.validateAuthorizeRequest({
      clientId: client_id,
      redirectUri: redirect_uri,
      responseType: 'code',
      scope,
      state,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      resource
    });

    if (!canAuthorizeClient(user, validated.client)) {
      return res.status(403).type('html').send(errorPage(403, 'This OAuth client belongs to a different mcp_worker identity.'));
    }

    const targetUrl = new URL(validated.redirectUri);

    if (action === 'allow') {
      const code = await mcpOAuthService.issueAuthorizationCode({
        clientId: validated.client.client_id,
        userId: user.id,
        principalId: validated.client.principal_id,
        redirectUri: validated.redirectUri,
        resource: validated.resource,
        scopes: validated.scopes,
        codeChallenge: validated.codeChallenge,
        codeChallengeMethod: validated.codeChallengeMethod
      });

      targetUrl.searchParams.set('code', code);
      if (validated.state) targetUrl.searchParams.set('state', validated.state);
      targetUrl.searchParams.set('iss', mcpConfig.issuer);
      return res.redirect(targetUrl.toString());
    } else {
      targetUrl.searchParams.set('error', 'access_denied');
      targetUrl.searchParams.set('error_description', 'Owner denied the authorization request.');
      if (validated.state) targetUrl.searchParams.set('state', validated.state);
      targetUrl.searchParams.set('iss', mcpConfig.issuer);
      return res.redirect(targetUrl.toString());
    }
  } catch (err) {
    const failure = oauthFailure(err);
    if (await isSafeErrorRedirect(client_id, redirect_uri)) {
      try {
        const u = new URL(redirect_uri);
        u.searchParams.set('error', failure.error);
        u.searchParams.set('error_description', failure.message);
        if (state) u.searchParams.set('state', state);
        u.searchParams.set('iss', mcpConfig.issuer);
        return res.redirect(u.toString());
      } catch (_) {}
    }

    return res.status(failure.status).type('html').send(errorPage(failure.status, failure.message));
  }
});

// ============================================================================
// Token Endpoint (/oauth/token)
// ============================================================================

router.post('/oauth/token', tokenRateLimiter, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');

  const credentials = extractClientCredentials(req);
  if (!credentials) {
    res.setHeader('WWW-Authenticate', 'Basic realm="mcp_worker Gateway"');
    return res.status(401).json({
      error: 'invalid_client',
      error_description: 'Client authentication required.'
    });
  }

  const { clientId, clientSecret } = credentials;
  const grantType = req.body?.grant_type;

  try {
    if (grantType === 'authorization_code') {
      const tokenResult = await mcpOAuthService.exchangeAuthorizationCode({
        clientId,
        clientSecret,
        code: req.body?.code,
        redirectUri: req.body?.redirect_uri,
        resource: req.body?.resource,
        codeVerifier: req.body?.code_verifier
      });
      return res.status(200).json(tokenResult);
    }

    if (grantType === 'refresh_token') {
      const tokenResult = await mcpOAuthService.exchangeRefreshToken({
        clientId,
        clientSecret,
        refreshToken: req.body?.refresh_token,
        scope: req.body?.scope,
        resource: req.body?.resource
      });
      return res.status(200).json(tokenResult);
    }

    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: `Grant type '${grantType}' is not supported. Supported grant types: authorization_code, refresh_token.`
    });
  } catch (err) {
    const failure = oauthFailure(err);
    const status = failure.status;
    if (failure.error === 'invalid_client') {
      res.setHeader('WWW-Authenticate', 'Basic realm="mcp_worker Gateway"');
    }
    return res.status(status).json({
      error: failure.error,
      error_description: failure.description
    });
  }
});

// ============================================================================
// Token Revocation Endpoint (/oauth/revoke)
// ============================================================================

router.post('/oauth/revoke', async (req, res) => {
  const credentials = extractClientCredentials(req);
  if (!credentials) {
    res.setHeader('WWW-Authenticate', 'Basic realm="mcp_worker Gateway"');
    return res.status(401).json({
      error: 'invalid_client',
      error_description: 'Client authentication required.'
    });
  }

  const { clientId, clientSecret } = credentials;
  const token = req.body?.token;
  const tokenTypeHint = req.body?.token_type_hint;

  try {
    await mcpOAuthService.revokeToken({
      clientId,
      clientSecret,
      token,
      tokenTypeHint
    });
    return res.status(200).json({});
  } catch (err) {
    const failure = oauthFailure(err);
    const status = failure.status;
    return res.status(status).json({
      error: failure.error,
      error_description: failure.description
    });
  }
});

export = router;
