/**
 * T3 REVIEW ONLY: offline Railway SDK topology with a deliberately INVALID
 * image-source sentinel. A GitHub source MUST NOT be used: Railway would
 * build remotely. No image digest has been published or owner-approved.
 *
 * The program rejects every non-plan context and is NOT a deployment path.
 * Real Template Composer configuration is manual and separately authorized.
 */
import { defineRailway, image, preserve, project, service, volume } from 'railway/iac';

const UNAPPROVED_IMAGE_SENTINEL = 'OWNER_APPROVAL_REQUIRED_PREBUILT_IMAGE_DIGEST';

export default defineRailway((ctx) => {
  if (ctx.command !== 'plan') {
    throw new Error(
      'RAILWAY_REVIEW_ONLY: no approved registry digest; apply/deploy/template blocked',
    );
  }

  const data = volume('sqlite-data', { region: 'us-west2', sizeMB: 512 });
  const app = service('mcp-worker', {
    // Intentionally invalid registry source. NEVER resolve from git, a local
    // Docker config/image ID, a mutable tag, or a guessed registry digest.
    source: image(UNAPPROVED_IMAGE_SENTINEL),
    replicas: 1,
    healthcheck: '/healthz',
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    volumeMounts: { '/app/data': data },
    env: {
      NODE_ENV: 'production',
      MCP_PLATFORM: 'railway',
      DATABASE_PATH: '/app/data/bot_report.sqlite',
      PORT: '80',
      HOST: '0.0.0.0',
      ADMIN_USERNAME: 'admin',
      // Railway root-owned volume needs a transient privileged initializer;
      // entrypoint then execs the application as node UID/GID 1000.
      RAILWAY_RUN_UID: '0',
      RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: '0',
      MCP_SETUP_SECRET: preserve(),
    },
    // HTTPS and real domain require owner-approved Railway provisioning.
  });
  return project('mcp-worker-private', { resources: [app, data] });
});
