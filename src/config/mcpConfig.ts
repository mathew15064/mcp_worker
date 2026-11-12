import { URL } from 'node:url';
import runtimeSettings from '../services/runtimeSettingsService';
import databaseManager from '../db/databaseManager';
import { canonicalVercelOrigin } from './managedStorage';

const DEFAULT_SCOPES = Object.freeze(['bot_report.read', 'bot_report.terminal', 'offline_access']);

class McpConfig {
  get enabled() {
    return databaseManager.isOperational() && runtimeSettings.bool('mcp.enabled', true);
  }
  get publicBaseUrl() {
    // Preview deployment hostnames are ephemeral. Do not persist the first
    // deployment URL as the issuer for every future OAuth/PKCE callback.
    // On Vercel the platform-provided stable project hostname is authoritative.
    if (process.env.MCP_PLATFORM === 'vercel') {
      const origin = canonicalVercelOrigin();
      if (!origin) throw new Error('Vercel canonical origin is unavailable.');
      return origin;
    }
    return String(runtimeSettings.get('mcp.public_base_url', 'http://localhost:3333')).replace(
      /\/+$/,
      '',
    );
  }
  get resourceUrl() {
    return `${this.publicBaseUrl}/mcp`;
  }
  get issuer() {
    return this.publicBaseUrl;
  }
  get accessTokenTtlSeconds() {
    return runtimeSettings.int('mcp.access_token_ttl_seconds', 900, { min: 60, max: 86400 });
  }
  get refreshTokenTtlSeconds() {
    return runtimeSettings.int('mcp.refresh_token_ttl_seconds', 2592000, {
      min: 3600,
      max: 31536000,
    });
  }
  get authCodeTtlSeconds() {
    return runtimeSettings.int('mcp.auth_code_ttl_seconds', 300, { min: 60, max: 3600 });
  }
  get rateLimitPerMinute() {
    return runtimeSettings.int('mcp.rate_limit_per_minute', 120, { min: 1, max: 10000 });
  }
  get supportedScopes() {
    return DEFAULT_SCOPES;
  }

  get metadataUrls() {
    const base = this.publicBaseUrl;
    return {
      protectedResourceMcp: `${base}/.well-known/oauth-protected-resource/mcp`,
      protectedResourceRoot: `${base}/.well-known/oauth-protected-resource`,
      authorizationServer: `${base}/.well-known/oauth-authorization-server`,
      authorizationEndpoint: `${base}/oauth/authorize`,
      tokenEndpoint: `${base}/oauth/token`,
      revocationEndpoint: `${base}/oauth/revoke`,
    };
  }

  validate() {
    const errors = [];
    try {
      const publicUrl = new URL(this.publicBaseUrl);
      if (!['http:', 'https:'].includes(publicUrl.protocol))
        errors.push('MCP Public Base URL must use HTTP or HTTPS.');
      if (
        process.env.NODE_ENV === 'production' &&
        databaseManager.isSqlReady() &&
        publicUrl.protocol !== 'https:'
      ) {
        errors.push('MCP Public Base URL must use HTTPS in production.');
      }
    } catch (_) {
      errors.push(`Invalid MCP Public Base URL: '${this.publicBaseUrl}'.`);
    }
    return { valid: errors.length === 0, errors };
  }
}

const instance = Object.assign(new McpConfig(), { McpConfig, DEFAULT_SCOPES });
export = instance;
