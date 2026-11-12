/** Dedicated Vercel Function entrypoint. Docker/VPS keeps src/server.ts.
 *
 * Do not import the application until per-instance secret and Redis are present:
 * failing closed must not accidentally create process-memory sessions.
 */
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';

process.env.MCP_PLATFORM = 'vercel';

const required: string[] = [];
if (!process.env.MCP_SETUP_SECRET || !/^[A-Za-z0-9_-]{43,}$/.test(process.env.MCP_SETUP_SECRET))
  required.push('MCP_SETUP_SECRET');
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN)
  required.push('Upstash Redis');
if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) required.push('Neon PostgreSQL');
if (!process.env.VERCEL_PROJECT_PRODUCTION_URL) required.push('Production URL');
const readyToStart = required.length === 0;

const failClosed: RequestListener = (req, res) => {
  res.statusCode = 503;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.url === '/readyz' || req.url === '/healthz' || req.url?.startsWith('/.well-known/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ ready: false, code: 'SETUP_PREREQUISITES_MISSING', missing: required }),
    );
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configure mcp_worker</title><style>body{font:16px system-ui;max-width:580px;margin:6vh auto;padding:1.5rem;color:#1c2434;line-height:1.6}li{margin:.7rem 0}a{color:#2551ba}</style><h1>mcp_worker — Private deployment</h1><p>This project has not completed its independent Vercel setup.</p><ol><li>Add <strong>Neon PostgreSQL</strong> in Vercel Storage and connect it to this project.</li><li>Add <strong>Upstash Redis</strong> and connect it to this project.</li><li>Add a fresh 43+ character random <code>MCP_SETUP_SECRET</code> in Vercel Project Settings → Environment Variables.</li><li>Redeploy the project, then return to <code>/setup</code> to claim ownership.</li></ol><p>No default Admin password is created. Your data is never linked to the project's original author.</p></html>`,
  );
};

let serve: RequestListener = failClosed;
let init: Promise<void> = Promise.resolve();

if (readyToStart) {
  const app = require('../src/app') as typeof import('../src/app');
  const databaseManager =
    require('../src/db/databaseManager') as typeof import('../src/db/databaseManager');
  const runtimeSettings =
    require('../src/services/runtimeSettingsService') as typeof import('../src/services/runtimeSettingsService');
  const workerBroker =
    require('../src/services/workerConnectionBroker') as typeof import('../src/services/workerConnectionBroker');
  init = (async () => {
    await databaseManager.initialize();
    if (databaseManager.isSqlReady())
      await runtimeSettings.seedDefaults(databaseManager.getAdapter());
    else await runtimeSettings.load(null);
  })();
  serve = (req, res) => {
    void init
      .then(() => app(req, res))
      .catch((error) => {
        console.error(
          '[VERCEL_BOOT] initialization failed:',
          error instanceof Error ? error.name : 'ERROR',
        );
        if (!res.headersSent) {
          res.statusCode = 503;
          res.setHeader('Cache-Control', 'no-store');
          res.end('Service temporarily unavailable. Check the private deployment setup.');
        }
      });
  };
  const server = createServer((req, res) => serve(req, res));
  workerBroker.attach(server);
  module.exports = server;
} else {
  module.exports = createServer(failClosed);
}
