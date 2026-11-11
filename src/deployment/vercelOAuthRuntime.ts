import type { DatabaseAdapter } from '../db/contracts';
import { LibsqlAdapter } from '../db/adapters/libsqlAdapter';
import { MigrationRunner } from '../db/migrationRunner';
import { LibsqlSessionStore } from '../db/libsqlSessionStore';
import { PreviewOwnerClaimService } from './previewOwnerClaim';
import { createSessionMiddleware } from '../middleware/createSessionMiddleware';
import oauthRepository from '../repositories/mcpOAuthRepository';
import oauthService from '../services/mcpOAuthService';
import type { OAuthConfig } from '../services/contracts/oauthContracts';
import type { DeploymentEnvironment } from './profile';
import { parsePreviewConfig, PreviewUnavailable } from './vercelPreview';
import type { PreviewAdapterFactory } from './vercelPreview';

function readTtl(
  environment: DeploymentEnvironment,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');
  }
  return value;
}

/**
 * Immutable request-scope OAuth policy, built from trusted deployment config.
 * Avoid importing the global MySQL-backed runtimeSettingsService singleton.
 */
export function buildPreviewOAuthPolicy(
  environment: DeploymentEnvironment = process.env,
): OAuthConfig {
  parsePreviewConfig(environment);
  const origin = environment.MCP_PUBLIC_BASE_URL;
  if (!origin) throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');
  return Object.freeze({
    supportedScopes: Object.freeze(['bot_report.read', 'bot_report.terminal', 'offline_access']),
    resourceUrl: origin.replace(/\/+$/, '') + '/mcp',
    accessTokenTtlSeconds: readTtl(environment, 'MCP_ACCESS_TOKEN_TTL_SECONDS', 900, 60, 86400),
    refreshTokenTtlSeconds: readTtl(
      environment,
      'MCP_REFRESH_TOKEN_TTL_SECONDS',
      2592000,
      3600,
      31536000,
    ),
    authCodeTtlSeconds: readTtl(environment, 'MCP_AUTH_CODE_TTL_SECONDS', 300, 60, 3600),
  });
}

/**
 * Metadata endpoints for a verified preview origin only. This route policy
 * does not activate a server, consent page or real owner authentication.
 */
export function buildPreviewOAuthRouteConfig(environment: DeploymentEnvironment = process.env) {
  const policy = buildPreviewOAuthPolicy(environment);
  const issuer = policy.resourceUrl.slice(0, -'/mcp'.length);
  return Object.freeze({
    enabled: true,
    rateLimitPerMinute: readTtl(environment, 'MCP_RATE_LIMIT_PER_MINUTE', 120, 1, 10000),
    resourceUrl: policy.resourceUrl,
    issuer,
    supportedScopes: policy.supportedScopes,
    metadataUrls: Object.freeze({
      protectedResourceMcp: issuer + '/.well-known/oauth-protected-resource/mcp',
      protectedResourceRoot: issuer + '/.well-known/oauth-protected-resource',
      authorizationServer: issuer + '/.well-known/oauth-authorization-server',
      authorizationEndpoint: issuer + '/oauth/authorize',
      tokenEndpoint: issuer + '/oauth/token',
      revocationEndpoint: issuer + '/oauth/revoke',
    }),
  });
}

export interface PreviewOAuthRuntime {
  readonly adapter: DatabaseAdapter;
  readonly sessions: LibsqlSessionStore;
  readonly owner: PreviewOwnerClaimService;
  readonly sessionMiddleware: ReturnType<typeof createSessionMiddleware>;
  readonly repository: InstanceType<typeof oauthRepository.McpOAuthRepository>;
  readonly oauth: InstanceType<typeof oauthService.McpOAuthService>;
  readonly policy: OAuthConfig;
  close(): Promise<void>;
}

/**
 * Assemble a scoped libSQL/OAuth/session runtime *without* activating routes.
 *
 * This function is an injection seam for the future Vercel Express entrypoint.
 * Do not expose authorization/code/claim/token routes until OAuth consent,
 * Admin ownership, CSRF and public HTTPS tests are completed independently.
 *
 * Readiness checks perform SELECTs only: no migrations or account creation.
 */
export async function createPreviewOAuthRuntime(
  environment: DeploymentEnvironment = process.env,
  adapterFactory: PreviewAdapterFactory = (config) => LibsqlAdapter.createRemote(config),
): Promise<PreviewOAuthRuntime> {
  const config = parsePreviewConfig(environment);
  const policy = buildPreviewOAuthPolicy(environment);
  const secret = environment.SESSION_SECRET;
  const ownerProof = environment.VERCEL_OWNER_CLAIM_TOKEN;
  if (!secret || !ownerProof || ownerProof.length < 32)
    throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');

  let adapter: DatabaseAdapter | null = null;
  try {
    adapter = await adapterFactory(config);
    if (adapter.kind !== 'libsql') throw new PreviewUnavailable('VERCEL_PREVIEW_DATABASE_UNREADY');
    await adapter.ping();
    const source = await new MigrationRunner(adapter).inspectSource();
    if (!source.initialized || source.pending.length !== 0)
      throw new PreviewUnavailable('VERCEL_PREVIEW_DATABASE_UNREADY');

    const sessions = new LibsqlSessionStore({ adapter, secret });
    await sessions.verifyExisting(); // read-only: provision schema explicitly
    const owner = new PreviewOwnerClaimService(adapter, ownerProof);
    await owner.verifyExisting(); // read-only; no account claim on cold start
    const repository = new oauthRepository.McpOAuthRepository(adapter);
    const oauth = new oauthService.McpOAuthService(repository, policy);
    const sessionMiddleware = createSessionMiddleware({
      store: sessions,
      secret,
      secureCookie: true,
    });
    const ownedAdapter = adapter;
    return Object.freeze({
      adapter: ownedAdapter,
      sessions,
      owner,
      sessionMiddleware,
      repository,
      oauth,
      policy,
      async close() {
        sessions.close();
        await ownedAdapter.close();
      },
    });
  } catch {
    await adapter?.close().catch(() => undefined);
    throw new PreviewUnavailable('VERCEL_PREVIEW_DATABASE_UNREADY');
  }
}
