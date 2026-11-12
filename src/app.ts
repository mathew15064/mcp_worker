import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import config from './config/env';
import databaseManager from './db/databaseManager';
import sessionMiddleware from './middleware/sessionMiddleware';
import { csrfProtection } from './middleware/csrfMiddleware';
import workerRoutes from './routes/workerRoutes';
import authRoutes from './routes/authRoutes';
import setupRoutes from './routes/setupRoutes';
import railwaySetupRoutes from './routes/railwaySetupRoutes';
import { canonicalRailwayOrigin } from './config/railwayOrigin';
import accountRoutes from './routes/accountRoutes';
import adminRoutes from './routes/adminRoutes';
import mcpOAuthRoutes from './routes/mcpOAuthRoutes';
import { createMcpRouter } from './mcp/transport';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY);
app.use(
  '/assets',
  express.static(path.join(__dirname, 'public'), { fallthrough: false, maxAge: '1h' }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(sessionMiddleware);
app.use(csrfProtection);

app.get('/healthz', (req, res) => {
  const database = databaseManager.status();
  res.json({ ok: true, service: 'mcp_worker', mode: 'mcp-admin', database: database.state });
});
app.get('/readyz', async (req, res, next) => {
  try {
    const database = databaseManager.status();
    let railwayOriginReady = true;
    if (process.env.MCP_PLATFORM === 'railway') {
      try {
        railwayOriginReady = Boolean(canonicalRailwayOrigin());
      } catch {
        railwayOriginReady = false;
      }
    }
    const ready =
      database.operational &&
      railwayOriginReady &&
      (process.env.MCP_PLATFORM !== 'vercel' || (await setupRoutes.isOwnerSetupComplete())) &&
      (process.env.MCP_PLATFORM !== 'railway' || (await railwaySetupRoutes.isOwnerSetupComplete()));
    // Vercel's cross-instance Worker dispatch remains under development.
    // Even with setup complete, never advertise execution readiness until
    // the distributed Redis broker has passed its separate acceptance gate.
    const workerTransportReady = process.env.MCP_PLATFORM !== 'vercel';
    return res.status(ready && workerTransportReady ? 200 : 503).json({
      ready: ready && workerTransportReady,
      database: database.state,
      workerTransportReady,
      railwayOriginReady,
    });
  } catch (error) {
    return next(error);
  }
});
if (process.env.MCP_PLATFORM === 'vercel') {
  app.use('/', setupRoutes);
  app.use(async (req, res, next) => {
    try {
      if (await setupRoutes.isOwnerSetupComplete()) return next();
      res.set('Cache-Control', 'no-store');
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return res.status(503).json({ code: 'SETUP_REQUIRED', error: 'Instance not initialized' });
      return res.redirect('/setup');
    } catch (error) {
      next(error);
    }
  });
}
if (process.env.MCP_PLATFORM === 'railway') {
  app.use('/', railwaySetupRoutes);
  app.use(async (req, res, next) => {
    try {
      if (await railwaySetupRoutes.isOwnerSetupComplete()) return next();
      res.set('Cache-Control', 'no-store');
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return res.status(503).json({ code: 'SETUP_REQUIRED', error: 'Instance not initialized' });
      return res.redirect('/setup');
    } catch (error) {
      next(error);
    }
  });
}
app.get('/', (req, res) => res.redirect('/admin'));

app.use('/', workerRoutes);
app.use('/', authRoutes);
app.use('/', accountRoutes);
app.use('/', adminRoutes);
app.use('/', mcpOAuthRoutes);
app.use('/', createMcpRouter().router);

app.use((req, res) => res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' }));
const handleError: ErrorRequestHandler = (err: unknown, req, res, next) => {
  const details =
    err && typeof err === 'object'
      ? (err as { code?: string; name?: string; message?: string; status?: number })
      : {};
  if (res.headersSent) return next(err);
  console.error(
    '[HTTP_ERROR]',
    details.code || details.name || 'ERROR',
    details.message || 'Unknown error',
  );
  return res
    .status(details.status || 500)
    .json({ error: 'Internal Server Error', code: details.code || 'INTERNAL_ERROR' });
};
app.use(handleError);

export = app;
