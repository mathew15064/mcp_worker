import crypto from 'node:crypto';
import type { DatabaseAdapter } from '../db/contracts';
import { LibsqlAdapter, validateRemoteLibsqlConfig } from '../db/adapters/libsqlAdapter';
import type { DeploymentEnvironment } from './profile';
import { resolveDeploymentProfile } from './profile';

/**
 * Read-only probe for a disposable Vercel Preview deployment.
 * This is NOT the application/MCP/OAuth handler. Full Vercel profiles
 * remain unavailable until worker routing, first-owner claim and full E2E.
 */
export interface VercelPreviewConfig {
  url: string;
  authToken: string;
}

export type PreviewAdapterFactory = (config: VercelPreviewConfig) => Promise<DatabaseAdapter>;

export class PreviewUnavailable extends Error {
  constructor(
    readonly code:
      | 'VERCEL_PREVIEW_DISABLED'
      | 'VERCEL_PREVIEW_INVALID_CONFIGURATION'
      | 'VERCEL_PREVIEW_DATABASE_UNREADY',
  ) {
    super(code);
    this.name = 'PreviewUnavailable';
  }
}

export function parsePreviewConfig(
  environment: DeploymentEnvironment = process.env,
): VercelPreviewConfig {
  // Absolutely never expose this diagnostic route in a production deployment.
  if (environment.VERCEL_ENV !== 'preview' || environment.VERCEL_PREVIEW_ENABLED !== 'true')
    throw new PreviewUnavailable('VERCEL_PREVIEW_DISABLED');

  const profile = resolveDeploymentProfile(environment);
  if (profile.id !== 'vercel-sandbox')
    throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');

  if (
    !environment.SESSION_SECRET ||
    environment.SESSION_SECRET.length < 32 ||
    !environment.VERCEL_PREVIEW_PROBE_TOKEN ||
    environment.VERCEL_PREVIEW_PROBE_TOKEN.length < 32
  )
    throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');

  const origin = environment.MCP_PUBLIC_BASE_URL;
  try {
    if (!origin) throw new Error('Missing public origin');
    const parsed = new URL(origin);
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      throw new Error('Unsafe public origin');
    }
  } catch {
    throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');
  }

  const url = environment.TURSO_DATABASE_URL;
  const authToken = environment.TURSO_AUTH_TOKEN;
  try {
    return validateRemoteLibsqlConfig({ url: url || '', authToken: authToken || '' });
  } catch {
    throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');
  }
}

function authorizedProbe(request: Request, environment: DeploymentEnvironment): boolean {
  const provided = request.headers.get('authorization') || '';
  const expected = 'Bearer ' + (environment.VERCEL_PREVIEW_PROBE_TOKEN || '');
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createVercelPreviewHandler(
  environment: DeploymentEnvironment = process.env,
  adapterFactory: PreviewAdapterFactory = (config) =>
    LibsqlAdapter.createRemote({
      url: config.url,
      authToken: config.authToken,
    }),
) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return Response.json(
        { ready: false, code: 'METHOD_NOT_ALLOWED' },
        { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } },
      );

    let config: VercelPreviewConfig;
    try {
      config = parsePreviewConfig(environment);
    } catch (error) {
      const code =
        error instanceof PreviewUnavailable ? error.code : 'VERCEL_PREVIEW_INVALID_CONFIGURATION';
      return Response.json(
        { ready: false, code },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }

    if (!authorizedProbe(request, environment))
      return Response.json(
        { ready: false, code: 'NOT_FOUND' },
        { status: 404, headers: { 'cache-control': 'no-store' } },
      );

    let adapter: DatabaseAdapter | null = null;
    try {
      adapter = await adapterFactory(config);
      await adapter.ping();
      const migrations = await adapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) AS count FROM migrations',
      );
      const sessions = await adapter.queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'admin_sessions'",
      );
      // This endpoint proves DB connectivity and required schema only.
      // It is intentionally not an OAuth login, MCP transport or Worker.
      if (Number(migrations?.count) < 13 || Number(sessions?.count) !== 1)
        throw new PreviewUnavailable('VERCEL_PREVIEW_DATABASE_UNREADY');
      return Response.json(
        { ready: true, service: 'mcp_worker', preview: 'database-only', mcpAvailable: false },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch {
      return Response.json(
        { ready: false, code: 'VERCEL_PREVIEW_DATABASE_UNREADY' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    } finally {
      await adapter?.close().catch(() => undefined);
    }
  };
}
