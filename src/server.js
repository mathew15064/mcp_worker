const app = require('./app');
const config = require('./config/env');
const mcpConfig = require('./config/mcpConfig');
const databaseManager = require('./db/databaseManager');
const runtimeSettings = require('./services/runtimeSettingsService');
const sessionMiddleware = require('./middleware/sessionMiddleware');
const { closeDb } = require('./db/connection');

let server = null;
let terminalWebSocket = null;
let workerBroker = null;
let closing = false;

async function bootstrap() {
  const storage = await databaseManager.initialize();
  if (databaseManager.isMysqlReady()) await runtimeSettings.seedDefaults(databaseManager.getAdapter());
  else if (databaseManager.isOperational()) await runtimeSettings.load(databaseManager.getAdapter());
  else await runtimeSettings.load(null);

  const validation = mcpConfig.validate();
  if (!validation.valid) console.warn(`[MCP_CONFIG] ${validation.errors.join('; ')}`);

  server = app.listen(config.PORT, config.HOST, () => {
    console.log(`[BOOT] Bot Report listening on http://${config.HOST}:${config.PORT}`);
    console.log(`[BOOT] Storage state: ${storage.state}`);
    if (databaseManager.isOperational()) console.log(`[BOOT] MCP resource: ${mcpConfig.resourceUrl}`);
  });
  terminalWebSocket = require('./services/terminalWebSocketService').attachTerminalWebSocket(server);
  workerBroker = require('./services/workerConnectionBroker');
  workerBroker.attach(server);
  return server;
}

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[SHUTDOWN] ${signal}`);
  try { terminalWebSocket?.close(); } catch (_) {}
  try { workerBroker?.close(); } catch (_) {}
  try { sessionMiddleware.store?.close?.(); } catch (_) {}
  try { await databaseManager.close(); } catch (_) {}
  try { closeDb(); } catch (_) {}
  if (!server) return process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

const ready = bootstrap().catch(error => {
  console.error('[BOOT_FATAL]', error?.code || error?.name || 'ERROR', error?.message || error);
  process.exitCode = 1;
  throw error;
});

module.exports = { ready, get server() { return server; }, shutdown };
