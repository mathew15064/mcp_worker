import app = require('./app');
import type {Server} from 'node:http';
import config = require('./config/env');
import mcpConfig = require('./config/mcpConfig');
import databaseManager = require('./db/databaseManager');
import runtimeSettings = require('./services/runtimeSettingsService');
import sessionMiddleware = require('./middleware/sessionMiddleware');
import {closeDb} from './db/connection';
import workerBrokerService = require('./services/workerConnectionBroker');
interface Closable {close(): void}
interface TerminalWebSocketModule {attachTerminalWebSocket(server: Server): Closable}
const terminalWebSocketModule: TerminalWebSocketModule = require('./services/terminalWebSocketService');

let server: Server | null = null;
let terminalWebSocket: Closable | null = null;
let workerBroker: typeof workerBrokerService | null = null;
let closing = false;

async function bootstrap(): Promise<Server> {
  const storage = await databaseManager.initialize();
  if (databaseManager.isMysqlReady()) await runtimeSettings.seedDefaults(databaseManager.getAdapter());
  else if (databaseManager.isOperational()) await runtimeSettings.load(databaseManager.getAdapter());
  else await runtimeSettings.load(null);

  const validation = mcpConfig.validate();
  if (!validation.valid) console.warn(`[MCP_CONFIG] ${validation.errors.join('; ')}`);

  server = app.listen(config.PORT, config.HOST, () => {
    console.log(`[BOOT] mcp_worker listening on http://${config.HOST}:${config.PORT}`);
    console.log(`[BOOT] Storage state: ${storage.state}`);
    if (databaseManager.isOperational()) console.log(`[BOOT] MCP resource: ${mcpConfig.resourceUrl}`);
  });
  terminalWebSocket = terminalWebSocketModule.attachTerminalWebSocket(server);
  workerBroker = workerBrokerService;
  workerBroker.attach(server);
  return server;
}

async function shutdown(signal: string): Promise<void> {
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

const ready = bootstrap().catch((error: unknown) => {
  const fields = error && typeof error === 'object' ? error as {code?: string; name?: string; message?: string} : {};
  console.error('[BOOT_FATAL]', fields.code || fields.name || 'ERROR', fields.message || error);
  process.exitCode = 1;
  throw error;
});

export = { ready, get server() { return server; }, shutdown };
