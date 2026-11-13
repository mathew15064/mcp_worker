/**
 * Review-only Railway IaC; never apply without owner approval.
 * REVIEW ONLY: the immutable Wave 2 baseline SHA below is a placeholder,
 * NOT a T02 release artifact. Pin an approved, tested SHA before publication.
 * Exactly one app service, one SQLite volume and one replica.
 */
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("sqlite-data", { region: "us-west2", sizeMB: 512 });
  const app = service("mcp-worker", {
    source: github("mathew15064/mcp_worker", {
      branch: "review/railway-p15-t05-integration",
      commitSha: "e7de57a28f4894d302a6dfb24a577ea7b38b9a08",
    }),
    replicas: 1,
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
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
