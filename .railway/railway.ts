/**
 * REVIEW ONLY: offline SDK topology for a future owner-approved release.
 * A zero-SHA and nonexistent release branch are deliberate non-deployable
 * placeholders, NOT a production source, and this module rejects apply/deploy.
 * Owner approval, exact reachable release pin and a separately reviewed guard
 * change are required before any live action or template publication.
 */
import { defineRailway, github, preserve, project, service, volume } from 'railway/iac';

export default defineRailway((ctx) => {
  if (ctx.command !== 'plan') {
    throw new Error(
      'RAILWAY_REVIEW_ONLY: no approved source; Railway apply/deploy/template blocked',
    );
  }

  const data = volume('sqlite-data', { region: 'us-west2', sizeMB: 512 });
  const app = service('mcp-worker', {
    source: github('mathew15064/mcp_worker', {
      // Intentionally impossible source until the owner approves an immutable
      // release commit + reachable branch. Do not auto-fill from a local HEAD.
      branch: 'release/OWNER_APPROVAL_REQUIRED',
      commitSha: '0000000000000000000000000000000000000000',
    }),
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
      RAILWAY_DOCKERFILE_PATH: 'Dockerfile.railway',
      // Root initializes only the volume; the process then runs as UID 1000.
      RAILWAY_RUN_UID: '0',
      RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: '0',
      // NEVER auto-generate: owner must securely store and enter their key.
      MCP_SETUP_SECRET: preserve(),
    },
    // A real HTTPS service domain is unique to each Railway project and must
    // be generated and verified by the owner in Public Networking, not faked.
  });
  return project('mcp-worker-private', { resources: [app, data] });
});
