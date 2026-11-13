/**
 * Review-only Railway IaC; never apply without owner approval.
 * REVIEW ONLY: source is pinned to the complete Wave 2 integration snapshot.
 * That review SHA and branch are NOT approved for live deployment or publication.
 * Replace both only after the owner approves a complete final release source.
 * Exactly one app service, one SQLite volume and one replica.
 */
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("sqlite-data", { region: "us-west2", sizeMB: 512 });
  const app = service("mcp-worker", {
    source: github("mathew15064/mcp_worker", {
      branch: "review/railway-p15-w2-t05-integration",
      commitSha: "1d617c9abfaaea8b9feae32da269124d5e3d8fd2",
    }),
    replicas: 1,
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    volumeMounts: { "/app/data": data },
    env: {
      NODE_ENV: "production",
      MCP_PLATFORM: "railway",
      DATABASE_PATH: "/app/data/bot_report.sqlite",
      PORT: "80",
      HOST: "0.0.0.0",
      ADMIN_USERNAME: "admin",
      // Railway officially reads this service variable during Docker builds.
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.railway",
      // The Railway volume is root-owned; entrypoint drops privilege to node.
      RAILWAY_RUN_UID: "0",
      RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: "0",
      // Explicit owner action: supply and privately retain a unique secret.
      MCP_SETUP_SECRET: preserve(),
    },
  });
  return project("mcp-worker-private", { resources: [app, data] });
});
