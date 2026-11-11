import type { DatabaseAdapter } from '../db/contracts';
import { LibsqlAdapter } from '../db/adapters/libsqlAdapter';
import { MigrationRunner } from '../db/migrationRunner';
import { LibsqlSessionStore } from '../db/libsqlSessionStore';
import { parsePreviewConfig, PreviewUnavailable } from './vercelPreview';
import type { DeploymentEnvironment } from './profile';
import type { PreviewAdapterFactory } from './vercelPreview';

/**
 * Explicit test-only preview provisioning. It is NEVER called by HTTP.
 * Requires both a disposable-host acknowledgement and a preview-only flag.
 */
export async function provisionPreviewDatabase(
  environment: DeploymentEnvironment = process.env,
  adapterFactory: PreviewAdapterFactory = (config) => LibsqlAdapter.createRemote(config),
): Promise<{ appliedMigrations: number; schemaReady: boolean; previewOnly: true }> {
  const config = parsePreviewConfig(environment);
  const expectedHost = new URL(config.url).host;
  if (
    environment.VERCEL_PREVIEW_PROVISION_ACK !== 'yes-create-disposable-preview-schema' ||
    !expectedHost ||
    environment.VERCEL_PREVIEW_PROVISION_CONFIRM_HOST !== expectedHost
  ) {
    throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');
  }

  const secret = environment.SESSION_SECRET;
  if (!secret) throw new PreviewUnavailable('VERCEL_PREVIEW_INVALID_CONFIGURATION');

  const adapter: DatabaseAdapter = await adapterFactory(config);
  try {
    await adapter.ping();
    const migrated = await new MigrationRunner(adapter).migrate();
    const sessions = new LibsqlSessionStore({ adapter, secret });
    await sessions.initialize();
    const status = await new MigrationRunner(adapter).inspectSource();
    if (!status.initialized) throw new PreviewUnavailable('VERCEL_PREVIEW_DATABASE_UNREADY');
    return { appliedMigrations: migrated.ran.length, schemaReady: true, previewOnly: true };
  } finally {
    await adapter.close();
  }
}
