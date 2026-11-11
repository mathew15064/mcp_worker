import app from './app';
import type { Server } from 'node:http';
import config from './config/env';
import mcpConfig from './config/mcpConfig';
import runtimeSettings from './services/runtimeSettingsService';
import { closeDb } from './db/connection';
import { createAppRuntime } from './deployment/bootstrap';
import type { DeploymentRuntime } from './deployment/runtime';
import type { WorkerTransportPort } from './deployment/ports';
interface Closable {
  close(): void;
}
import terminalWebSocketModule from './services/terminalWebSocketService';

let server: Server | null = null;
let terminalWebSocket: Closable | null = null;
let workerBroker: WorkerTransportPort | null = null;
let deployment: DeploymentRuntime | null = null;
let closing = false;

async function bootstrap(): Promise<Server> {
  deployment = createAppRuntime();
  const { storage: databaseManager } = deployment;
  const storage = await databaseManager.initialize();
  if (databaseManager.isMysqlReady())
    await runtimeSettings.seedDefaults(databaseManager.getAdapter());
  else if (databaseManager.isOperational())
    await runtimeSettings.load(databaseManager.getAdapter());
  else await runtimeSettings.load(null);

  const validation = mcpConfig.validate();
  if (!validation.valid) console.warn(`[MCP_CONFIG] ${validation.errors.join('; ')}`);

  server = app.listen(config.PORT, config.HOST, () => {
    console.log(`[BOOT] mcp_worker listening on http://${config.HOST}:${config.PORT}`);
    console.log(`[BOOT] Storage state: ${storage.state}`);
    console.log(`[BOOT] Deployment profile: ${deployment?.profile.id || 'unknown'}`);
    if (databaseManager.isOperational())
      console.log(`[BOOT] MCP resource: ${mcpConfig.resourceUrl}`);
  });
  terminalWebSocket = terminalWebSocketModule.attachTerminalWebSocket(server);
  workerBroker = deployment.worker;
  workerBroker.attach(server);
  return server;
}

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[SHUTDOWN] ${signal}`);
  try {
    terminalWebSocket?.close();
  } catch (_) {}
  try {
    workerBroker?.close();
  } catch (_) {}
  try {
    deployment?.sessions.close();
  } catch (_) {}
  try {
    await deployment?.storage.close();
  } catch (_) {}
  try {
    closeDb();
  } catch (_) {}
  if (!server) return process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

function requestShutdown(signal: string): void {
  void shutdown(signal).catch((error: unknown) => {
    console.error('[SHUTDOWN_FATAL]', error instanceof Error ? error.message : 'Shutdown failed');
    process.exit(1);
  });
}
process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

const ready = bootstrap().catch((error: unknown) => {
  const fields =
    error && typeof error === 'object'
      ? (error as { code?: string; name?: string; message?: string })
      : {};
  console.error('[BOOT_FATAL]', fields.code || fields.name || 'ERROR', fields.message || error);
  process.exitCode = 1;
  throw error;
});

export = {
  ready,
  get server() {
    return server;
  },
  shutdown,
};
