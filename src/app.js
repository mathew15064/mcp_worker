const express = require('express');
const path = require('path');
const config = require('./config/env');
const databaseManager = require('./db/databaseManager');
const sessionMiddleware = require('./middleware/sessionMiddleware');
const { csrfProtection } = require('./middleware/csrfMiddleware');

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
  res.json({ ok: true, service: 'bot-report-mcp', mode: 'mcp-admin', database: database.state });
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
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[HTTP_ERROR]', err?.code || err?.name || 'ERROR', err?.message || 'Unknown error');
  return res.status(err?.status || 500).json({ error: 'Internal Server Error', code: err?.code || 'INTERNAL_ERROR' });
});

module.exports = app;
