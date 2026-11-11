import express, {type ErrorRequestHandler} from 'express';
import path from 'node:path';
import config = require('./config/env');
import databaseManager = require('./db/databaseManager');
import sessionMiddleware = require('./middleware/sessionMiddleware');
import {csrfProtection} from './middleware/csrfMiddleware';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY);
app.use('/assets', express.static(path.join(__dirname, 'public'), { fallthrough: false, maxAge: '1h' }));
app.use('/vendor/xterm', express.static(path.join(__dirname, '../node_modules/@xterm/xterm'), { fallthrough: false, maxAge: '1d' }));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, '../node_modules/@xterm/addon-fit'), { fallthrough: false, maxAge: '1d' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(sessionMiddleware);
app.use(csrfProtection);

app.get('/healthz', (req, res) => {
  const database = databaseManager.status();
  res.json({ ok: true, service: 'mcp_worker', mode: 'mcp-admin', database: database.state });
});
app.get('/readyz', (req, res) => {
  const database = databaseManager.status();
  return res.status(database.operational ? 200 : 503).json({ ready: database.operational, database: database.state });
});
app.get('/', (req, res) => res.redirect('/admin'));

app.use('/', require('./routes/workerRoutes'));
app.use('/', require('./routes/authRoutes'));
app.use('/', require('./routes/accountRoutes'));
app.use('/', require('./routes/adminRoutes'));
app.use('/', require('./routes/mcpOAuthRoutes'));
app.use('/', require('./mcp/transport').createMcpRouter().router);

app.use((req, res) => res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' }));
const handleError: ErrorRequestHandler = (err: unknown, req, res, next) => {
  const details = err && typeof err === 'object' ? err as {code?: string; name?: string; message?: string; status?: number} : {};
  if (res.headersSent) return next(err);
  console.error('[HTTP_ERROR]', details.code || details.name || 'ERROR', details.message || 'Unknown error');
  return res.status(details.status || 500).json({ error: 'Internal Server Error', code: details.code || 'INTERNAL_ERROR' });
};
app.use(handleError);

export = app;
