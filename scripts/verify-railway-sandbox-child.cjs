/* Sandbox-only IPC fixture. Never expose control commands over HTTP. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

(async () => {
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
  const resolved = path.resolve(volume);
  const tmp = fs.realpathSync(os.tmpdir()) + path.sep;
  if (process.env.NODE_ENV !== 'test' ||
      process.env.MCP_PLATFORM !== 'railway' ||
      process.env.HOST !== '127.0.0.1' ||
      !resolved.startsWith(tmp) ||
      fs.realpathSync(resolved) !== resolved ||
      path.resolve(process.env.DATABASE_PATH || '') !== path.join(resolved, 'bot_report.sqlite') ||
      !process.send) {
    throw new Error('Sandbox-only fixture refused an unsafe environment');
  }
  const dist = path.resolve(__dirname, '../src');
  const manager = require(path.join(dist, 'db/databaseManager.js'));
  const settings = require(path.join(dist, 'services/runtimeSettingsService.js'));
  const broker = require(path.join(dist, 'services/workerConnectionBroker.js'));
  const workers = require(path.join(dist, 'repositories/workerRepository.js'));
  const oauth = require(path.join(dist, 'services/mcpOAuthService.js'));
  const { getDb, closeDb } = require(path.join(dist, 'db/connection.js'));
  await manager.initialize();
  await settings.seedDefaults(manager.getAdapter());
  const app = require(path.join(dist, 'app.js'));
  const server = http.createServer(app);
  const secureServer = https.createServer({
    key: fs.readFileSync(process.env.W3_TEST_KEY_PATH),
    cert: fs.readFileSync(process.env.W3_TEST_CERT_PATH),
  }, app);
  broker.attach(secureServer);
  const listen = (s) => new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      s.removeListener('error', reject);
      resolve(s.address().port);
    });
  });
  const httpPort = await listen(server);
  const tlsPort = await listen(secureServer);
  process.send({ type: 'ready', httpPort, tlsPort });
  const close = (s) => new Promise((resolve) => s.close(() => resolve()));
  process.on('message', async (message) => {
    if (!message || typeof message.id !== 'number') return;
    try {
      let result;
      switch (message.op) {
        case 'oauthRegister':
          result = await oauth.registerClient(message.args);
          break;
        case 'enrollmentToken':
          result = await workers.createEnrollmentToken();
          break;
        case 'worker':
          result = await workers.findWorkerById(message.args.workerId);
          break;
        case 'profile':
          result = await workers.findProfileByName(message.args.name);
          break;
        case 'dispatch':
          result = await broker.dispatch(message.args.workerId, 'workspace.exec', {
            command: message.args.command,
          }, { timeoutMs: 2500 });
          break;
        case 'online':
          result = broker.isOnline(message.args.workerId);
          break;
        case 'restrict':
          { const socket = broker.connections.get(message.args.workerId);
            if (!socket || !socket.worker) throw new Error('Worker socket not found');
            socket.worker.capabilities = message.args.capabilities;
            result = true; }
          break;
        case 'marker':
          getDb().prepare('INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,?,?)')
            .run(message.args.key, message.args.value, new Date().toISOString());
          result = true;
          break;
        case 'backup':
          { const target = path.resolve(message.args.target);
            if (!target.startsWith(tmp) || target.startsWith(resolved + path.sep) ||
                fs.existsSync(target)) throw new Error('Off-volume backup path required');
            await getDb().backup(target);
            result = { bytes: fs.statSync(target).size, path: target }; }
          break;
        case 'stop':
          process.send({ id: message.id, ok: true });
          broker.close();
          await Promise.all([close(secureServer), close(server)]);
          require(path.join(dist, 'middleware/sessionMiddleware.js')).store.close();
          await manager.close();
          closeDb();
          process.exit(0);
          return;
        default: throw new Error('Unsupported sandbox operation');
      }
      process.send({ id: message.id, ok: true, result });
    } catch (error) {
      process.send({ id: message.id, ok: false, error: {
        code: error.code || 'ERROR', message: error.message || 'unknown',
      } });
    }
  });
})().catch((error) => {
  process.stderr.write('[sandbox boot] ' + (error.stack || error.message) + '\n');
  process.exit(1);
});
