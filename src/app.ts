import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import config from './config/env';
import databaseManager from './db/databaseManager';
import sessionMiddleware from './middleware/sessionMiddleware';
import { csrfProtection } from './middleware/csrfMiddleware';
import workerRoutes from './routes/workerRoutes';
import authRoutes from './routes/authRoutes';
import accountRoutes from './routes/accountRoutes';
import adminRoutes from './routes/adminRoutes';
import mcpOAuthRoutes from './routes/mcpOAuthRoutes';
import uiApiRoutes from './routes/uiApiRoutes';
import authService from './services/authService';
import fs from 'node:fs';
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
app.use('/api/ui', uiApiRoutes);

app.get('/healthz', (req, res) => {
  const database = databaseManager.status();
  res.json({ ok: true, service: 'mcp_worker', mode: 'mcp-admin', database: database.state });
});
app.get('/readyz', (_req, res) => {
  const database = databaseManager.status();
  return res.status(database.operational ? 200 : 503).json({
    ready: database.operational,
    database: database.state,
  });
});
app.get('/', (req, res) => res.redirect('/admin'));

// Browser-only React entrypoint. Existing POST actions remain untouched.
// Machine clients (Accept: */*) continue using established HTML contracts.
const unifiedUiFile = path.join(__dirname, 'public', 'ui', 'index.html');
app.use(async (req, res, next) => {
  if (req.method !== 'GET' || !String(req.headers.accept || '').includes('text/html'))
    return next();
  const url = req.path;
  const isUi = ['/login', '/register', '/registration-pending', '/oauth/authorize'].includes(url) ||
    url === '/admin' || url.startsWith('/admin/') ||
    url === '/account' || url.startsWith('/account/');
  if (!isUi || !fs.existsSync(unifiedUiFile)) return next();
  try {
    if (url.startsWith('/admin') || url.startsWith('/account')) {
      const identity = await authService.currentIdentity(req.session);
      const needed = url.startsWith('/admin') ? 'admin' : 'user';
      if (identity?.role !== needed) {
        if (req.session) req.session.returnTo = req.originalUrl;
        return res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
      }
    }
    res.set('Cache-Control', 'no-store');
    return res.type('html').sendFile(unifiedUiFile);
  } catch (error) { return next(error); }
});

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
