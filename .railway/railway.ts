/**
 * REVIEW ONLY. One service, one SQLite volume, one replica.
 *
 * This exact commit is a LOCAL review baseline, NOT a production release.
 * No approved release source exists. Intentionally reject ALL evaluation
 * commands except the offline SDK "plan" context; even "apply" is blocked.
 * A future approval must replace this guard and pin in a separately reviewed
 * change, verify GitHub reachability, and pass live acceptance independently.
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
      // Pinned to the source PR #30 review branch at the verified original SHA.
      // This is NOT the final integration SHA or an approved production release.
      // Apply/deploy are intentionally forbidden until final owner approval.
      branch: 'review/railway-p15-w3-t05-integration',
      commitSha: '9a817baabdaeb6a019083252dac6ca5077257474',
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
