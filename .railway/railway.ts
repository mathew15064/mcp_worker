/**
 * Developer review IaC. Do not apply without approving Railway compute/storage costs.
 * One app service, one SQLite volume, one replica; no provider databases.
 */
import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("sqlite-data", { region: "us-west2", sizeMB: 512 });
  const app = service("mcp-worker", {
    source: github("mathew15064/mcp_worker", {
      branch: "feature/railway-sqlite-oneclick-20261112",
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
      RAILWAY_DOCKERFILE_PATH: "Dockerfile.railway",
      RAILWAY_RUN_UID: "0",
      RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: "0",
      MCP_SETUP_SECRET: preserve(),
    },
  });
  return project("mcp-worker-private", { resources: [app, data] });
});
