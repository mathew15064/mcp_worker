import express, { type Request, type Response, type NextFunction } from 'express';
import { routeError } from '../http/domainErrors';
import { formString, formFlag, formList } from '../http/requestContracts';
import pages from '../http/pages';
const packageJson = require('../../package.json');
import authRoutes from './authRoutes';
const { currentAdmin } = authRoutes;
import oauthRepo from '../repositories/mcpOAuthRepository';
import oauthService from '../services/mcpOAuthService';
import workerRepo from '../repositories/workerRepository';
import workerBroker from '../services/workerConnectionBroker';
import workerLifecycleService from '../services/workerLifecycleService';
import settingsRepo from '../repositories/settingsRepository';
import telegramSecrets from '../services/telegramSecretService';
import telegramService from '../services/telegramService';
import runtimeSettings from '../services/runtimeSettingsService';
import legacyImporter from '../services/legacySqliteImportService';
import databaseManager from '../db/databaseManager';
import bootstrapConfigStore from '../db/bootstrapConfigStore';
const { normalizeDatabaseConfig } = bootstrapConfigStore;
import mcpConfig from '../config/mcpConfig';
import { TOOLS } from '../mcp/toolRegistry';
const {
  adminOverviewPage,
  onboardingPage,
  clientsPage,
  auditPage,
  workersPage,
  settingsPage,
  setupRequiredPage,
  errorPage,
} = pages;

const router = express.Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (currentAdmin(req)) return next();
  if (req.session) req.session.returnTo = req.originalUrl;
  return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
}

function requireDataStore(req: Request, res: Response, next: NextFunction) {
  if (databaseManager.isOperational()) return next();
  const status = databaseManager.status();
  return res
    .status(503)
    .type('html')
    .send(setupRequiredPage({ status, csrfToken: csrf(req) }));
}

function consumeFlash(req: Request) {
  const value = { success: req.session?.flashSuccess || '', error: req.session?.flashError || '' };
  if (req.session) {
    delete req.session.flashSuccess;
    delete req.session.flashError;
  }
  return value;
}
function setFlash(req: Request, kind: 'error' | 'success', message: string) {
  if (req.session) req.session[kind === 'error' ? 'flashError' : 'flashSuccess'] = message;
}
function setOneTimeSecret(req: Request, secret: { clientId: string; clientSecret: string }) {
  if (req.session) req.session.oauthOneTimeSecret = secret;
}
function consumeOneTimeSecret(req: Request) {
  const secret = req.session?.oauthOneTimeSecret || null;
  if (req.session) delete req.session.oauthOneTimeSecret;
  return secret;
}
function setWorkerEnrollment(req: Request, enrollment: { token: string; expires_at?: string }) {
  if (req.session) req.session.workerEnrollment = enrollment;
}
function consumeWorkerEnrollment(req: Request) {
  const value = req.session?.workerEnrollment || null;
  if (req.session) delete req.session.workerEnrollment;
  return value;
}
function csrf(req: Request) {
  return req.session?.csrfToken || '';
}

async function clientList() {
  return databaseManager.isOperational()
    ? (await oauthRepo.listClients()).filter((v): v is NonNullable<typeof v> => v !== null)
    : [];
}

async function requireActiveAdminWorker(workerId: string) {
  const worker = await workerRepo.findAdminWorkerById(workerId);
  if (!worker)
    throw Object.assign(new Error('Execution targets can only use global/admin-owned Workers.'), {
      code: 'WORKER_NOT_FOUND',
      status: 404,
    });
  if (!worker.enabled || !workerBroker.isOnline(worker.id)) {
    throw Object.assign(new Error('Execution targets require an enabled, online Worker.'), {
      code: 'WORKER_NOT_ONLINE',
      status: 409,
    });
  }
  return worker;
}

async function telegramConfig() {
  if (!databaseManager.isOperational()) return { enabled: false, hasToken: false, chatId: '' };
  const enabledValue =
    (await settingsRepo.get('telegram.enabled', null)) ??
    (await settingsRepo.get('telegram_mcp_enabled', null)) ??
    (await settingsRepo.get('telegram_enabled', 'false'));
  const token =
    (await settingsRepo.get('telegram.bot_token', null)) ??
    (await settingsRepo.get('telegram_mcp_bot_token', null)) ??
    (await settingsRepo.get('telegram_bot_token', ''));
  const chatId =
    (await settingsRepo.get('telegram.chat_id', null)) ??
    (await settingsRepo.get('telegram_mcp_chat_id', null)) ??
    (await settingsRepo.get('telegram_chat_id', ''));
  return { enabled: enabledValue === 'true', hasToken: Boolean(token), chatId: chatId || '' };
}

async function storedTelegramToken() {
  return (
    (await settingsRepo.get('telegram.bot_token', null)) ??
    (await settingsRepo.get('telegram_mcp_bot_token', null)) ??
    (await settingsRepo.get('telegram_bot_token', ''))
  );
}

async function migrateTelegramTokenIfNeeded() {
  const stored = await storedTelegramToken();
  if (!stored) return '';
  const migrated = telegramSecrets.needsMigration(stored)
    ? telegramSecrets.encrypt(telegramSecrets.decrypt(stored))
    : stored;
  if (migrated !== stored || !(await settingsRepo.get('telegram.bot_token', null))) {
    await runtimeSettings.set('telegram.bot_token', migrated);
  }
  return migrated;
}

function databaseFormInput(
  req: Request,
  { allowStoredPassword = true }: { allowStoredPassword?: boolean } = {},
) {
  const passwordInput = String(formString(req.body, 'password') || '');
  let password = passwordInput;
  if (!password && allowStoredPassword && bootstrapConfigStore.exists()) {
    const stored = bootstrapConfigStore.load();
    if (stored) password = stored.password;
  }
  return normalizeDatabaseConfig(
    {
      host: formString(req.body, 'host'),
      port: formString(req.body, 'port'),
      database: formString(req.body, 'database'),
      username: formString(req.body, 'username'),
      password,
      ssl: formFlag(req.body, 'ssl'),
    },
    { requirePassword: true },
  );
}

router.use('/admin', requireAdmin, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/admin', async (req, res, next) => {
  try {
    const operational = databaseManager.isOperational();
    const clients = operational ? await clientList() : [];
    const workers = operational
      ? (await workerRepo.listAdminWorkers()).filter((w): w is NonNullable<typeof w> => w !== null)
      : [];
    const telegram = await telegramConfig();
    const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
    return res.type('html').send(
      adminOverviewPage({
        runtime: {
          version: packageJson.version,
          gitSha: process.env.BOT_REPORT_GIT_SHA || null,
          buildTime: process.env.BOT_REPORT_BUILD_TIME || null,
          startedAt,
          nodeEnv: process.env.NODE_ENV || 'development',
          toolCount: TOOLS.length,
        },
        clients,
        workers,
        telegram,
        endpoint: mcpConfig.resourceUrl,
        storage: databaseManager.status(),
        csrfToken: csrf(req),
        ...consumeFlash(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

// Read-only progress: no new credentials, migrations or Worker jobs are issued here.
router.get('/admin/onboarding', async (req, res, next) => {
  try {
    const storage = databaseManager.status();
    const ready = databaseManager.isSqlReady();
    let workerReady = false,
      clientReady = false,
      firstCall = false;
    if (ready) {
      const [profiles, workers, clients, called] = await Promise.all([
        workerRepo.listAdminProfiles(),
        workerRepo.listAdminWorkers(),
        clientList(),
        oauthRepo.hasAdminRuntimeCall(),
      ]);
      const activeWorkerIds = new Set(
        workers
          .filter(
            (w): w is NonNullable<typeof w> =>
              w !== null && w.enabled && workerBroker.isOnline(w.id),
          )
          .map((w) => w.id),
      );
      workerReady = profiles.some(
        (p) => p !== null && p.enabled && activeWorkerIds.has(p.worker_id),
      );
      clientReady = clients.some(
        (c) =>
          !c.owner_user_id && c.status === 'active' && c.allowed_scopes.includes('bot_report.read'),
      );
      firstCall = called && clientReady;
    }
    return res.type('html').send(
      onboardingPage({
        storage,
        ready,
        workerReady,
        clientReady,
        firstCall,
        enabled: mcpConfig.enabled,
        baseUrl: mcpConfig.publicBaseUrl,
        csrfToken: csrf(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get('/admin/settings', (req, res) => res.redirect('/admin/settings/database'));

router.get('/admin/settings/:section', async (req, res, next) => {
  try {
    if (!['database', 'mcp', 'telegram', 'runtime'].includes(req.params.section)) {
      return res.status(404).type('html').send(errorPage(404, 'Unknown settings section.'));
    }
    const storage = databaseManager.status();
    const flash = consumeFlash(req);
    if (
      storage.state === 'MIGRATION_REQUIRED' &&
      req.session?.authSource === 'legacy' &&
      !flash.error
    ) {
      flash.error =
        'You are signed in with the legacy SQLite administrator credential. Update ADMIN_USERNAME / ADMIN_PASSWORD, sign out, and sign in with ENV credentials before activating MySQL.';
    }
    return res.type('html').send(
      settingsPage({
        activeSection: req.params.section,
        storage,
        legacy: legacyImporter.inspect(),
        mcp: {
          enabled: runtimeSettings.bool('mcp.enabled', true),
          publicBaseUrl: mcpConfig.publicBaseUrl,
          accessTokenTtlSeconds: mcpConfig.accessTokenTtlSeconds,
          refreshTokenTtlSeconds: mcpConfig.refreshTokenTtlSeconds,
          authCodeTtlSeconds: mcpConfig.authCodeTtlSeconds,
          rateLimitPerMinute: mcpConfig.rateLimitPerMinute,
        },
        telegram: await telegramConfig(),
        runtime: {
          version: packageJson.version,
          gitSha: process.env.BOT_REPORT_GIT_SHA || null,
          buildTime: process.env.BOT_REPORT_BUILD_TIME || null,
          nodeEnv: process.env.NODE_ENV || 'development',
          toolCount: TOOLS.length,
        },
        csrfToken: csrf(req),
        ...flash,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/admin/settings/database/test', async (req, res) => {
  try {
    const input = databaseFormInput(req);
    const result = await databaseManager.testMysql(input);
    if (String(req.get('accept') || '').includes('application/json')) return res.json(result);
    setFlash(
      req,
      'success',
      `MySQL connection successful (${result.version || 'unknown version'}, ${result.duration_ms} ms).`,
    );
  } catch (error) {
    if (String(req.get('accept') || '').includes('application/json'))
      return res.status(422).json({
        ok: false,
        code: routeError(error).code || 'MYSQL_CONNECT_FAILED',
        message: routeError(error).message,
      });
    setFlash(req, 'error', `MySQL connection failed: ${routeError(error).message}`);
  }
  return res.redirect('/admin/settings/database');
});

router.post('/admin/settings/database/save', async (req, res) => {
  if (req.session?.authSource !== 'env') {
    setFlash(
      req,
      'error',
      'Saving MySQL configuration requires an administrator session authenticated by ADMIN_USERNAME / ADMIN_PASSWORD from ENV.',
    );
    return res.redirect('/admin/settings/database');
  }
  try {
    const input = databaseFormInput(req);
    const status = await databaseManager.saveMysqlConfig(input);
    await runtimeSettings.load(status.operational ? databaseManager.getAdapter() : null);
    setFlash(
      req,
      'success',
      status.source?.initialized
        ? 'MySQL connection saved. Existing mcp_worker source detected and activated without schema changes.'
        : 'MySQL connection saved. No schema changes were applied. Initialize Source when you are ready.',
    );
  } catch (error) {
    setFlash(
      req,
      'error',
      `Database configuration could not be saved: ${routeError(error).message}`,
    );
  }
  return res.redirect('/admin/settings/database');
});

router.post('/admin/settings/database/initialize', async (req, res) => {
  if (req.session?.authSource !== 'env') {
    setFlash(
      req,
      'error',
      'Source initialization requires an administrator session authenticated by ADMIN_USERNAME / ADMIN_PASSWORD from ENV.',
    );
    return res.redirect('/admin/settings/database');
  }
  let prepared = null;
  try {
    const current = databaseManager.status();
    if (!current.mysql)
      throw new Error('Save the MySQL connection before initializing the source.');
    if (current.source?.initialized) {
      setFlash(req, 'success', 'mcp_worker source is already initialized.');
      return res.redirect('/admin/settings/database');
    }

    prepared = await databaseManager.prepareSourceInitialization();
    let imported = null;
    if (!prepared.beforeSource?.migrationTable && legacyImporter.available()) {
      imported = await legacyImporter.importTo(prepared.adapter);
    } else {
      await runtimeSettings.seedDefaults(prepared.adapter);
    }
    await databaseManager.activatePrepared(prepared);
    prepared = null;
    await runtimeSettings.load(databaseManager.getAdapter());
    setFlash(
      req,
      'success',
      imported?.imported
        ? `mcp_worker source initialized and legacy data imported successfully (${Object.values(imported.counts).reduce((a: number, b) => a + Number(b || 0), 0)} records).`
        : 'mcp_worker source initialized successfully.',
    );
  } catch (error) {
    if (prepared?.adapter)
      try {
        await prepared.adapter.close();
      } catch (_) {}
    setFlash(req, 'error', `Source initialization failed: ${routeError(error).message}`);
  }
  return res.redirect('/admin/settings/database');
});

router.post('/admin/settings/mcp', requireDataStore, async (req, res) => {
  try {
    const publicBaseUrl = String(formString(req.body, 'public_base_url') || '')
      .trim()
      .replace(/\/+$/, '');
    const url = new URL(publicBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('MCP Public Base URL must use HTTP or HTTPS.');
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
      throw new Error('MCP Public Base URL must use HTTPS in production.');
    const entries = {
      'mcp.enabled': formFlag(req.body, 'enabled') ? 'true' : 'false',
      'mcp.public_base_url': publicBaseUrl,
      'mcp.access_token_ttl_seconds': String(
        Math.max(
          60,
          Math.min(86400, Number(formString(req.body, 'access_token_ttl_seconds')) || 900),
        ),
      ),
      'mcp.refresh_token_ttl_seconds': String(
        Math.max(
          3600,
          Math.min(31536000, Number(formString(req.body, 'refresh_token_ttl_seconds')) || 2592000),
        ),
      ),
      'mcp.auth_code_ttl_seconds': String(
        Math.max(60, Math.min(3600, Number(formString(req.body, 'auth_code_ttl_seconds')) || 300)),
      ),
      'mcp.rate_limit_per_minute': String(
        Math.max(1, Math.min(10000, Number(formString(req.body, 'rate_limit_per_minute')) || 120)),
      ),
    };
    await runtimeSettings.setMany(entries);
    setFlash(req, 'success', 'MCP settings saved to database.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/admin/settings/mcp');
});

router.post('/admin/settings/telegram', requireDataStore, async (req, res) => {
  try {
    const chatId = String(formString(req.body, 'chat_id') || '').trim();
    if (chatId.length > 128 || /[\x00-\x1f\x7f]/.test(chatId))
      throw new Error('Telegram Chat ID is invalid.');
    await runtimeSettings.set('telegram.enabled', formFlag(req.body, 'enabled') ? 'true' : 'false');
    await runtimeSettings.set('telegram.chat_id', chatId);
    const token = String(formString(req.body, 'bot_token') || '').trim();
    if (token) await runtimeSettings.set('telegram.bot_token', telegramSecrets.encrypt(token));
    else await migrateTelegramTokenIfNeeded();
    setFlash(req, 'success', 'Telegram settings saved to database.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/admin/settings/telegram');
});

router.post('/admin/settings/telegram/test', requireDataStore, async (req, res) => {
  try {
    const encrypted = await migrateTelegramTokenIfNeeded();
    const chatId = await settingsRepo.get('telegram.chat_id', '');
    if (!encrypted || !chatId)
      throw new Error('Telegram Bot Token and Chat ID must be configured first.');
    await telegramService.sendTest(telegramSecrets.decrypt(encrypted), chatId);
    setFlash(req, 'success', 'Telegram test message delivered successfully.');
  } catch (error) {
    setFlash(req, 'error', `Telegram test failed: ${routeError(error).message}`);
  }
  return res.redirect('/admin/settings/telegram');
});

router.get('/admin/telegram', (req, res) => res.redirect('/admin/settings/telegram'));
router.post('/admin/telegram', (req, res) => res.redirect(307, '/admin/settings/telegram'));
router.post('/admin/telegram/test', (req, res) =>
  res.redirect(307, '/admin/settings/telegram/test'),
);

// Session-protected, read-only live state. A check request pings an already-connected
// Worker; while it is offline, the browser waits for the outbound reconnect.
router.get('/admin/workers/connection-status', requireDataStore, async (req, res, next) => {
  try {
    const workers = (await workerRepo.listWorkers()).filter(
      (v): v is NonNullable<typeof v> => v !== null,
    );
    const checkId = String(req.query.check || '');
    const target = workers.find((worker) => worker.id === checkId);
    const probe =
      target?.enabled && workerBroker.isOnline(checkId)
        ? await workerBroker.probeConnection(checkId)
        : null;
    res.set('Cache-Control', 'no-store');
    return res.json({
      workers: workers.map((worker) => ({
        id: worker.id,
        enabled: worker.enabled,
        connected: worker.enabled && workerBroker.isOnline(worker.id),
        last_seen_at: worker.last_seen_at,
      })),
      probe: probe ? { id: checkId, ...probe } : null,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/admin/workers', requireDataStore, async (req, res, next) => {
  try {
    const [storedWorkers, profiles] = await Promise.all([
      workerRepo.listWorkers(),
      workerRepo.listProfiles(),
    ]);
    const workers = storedWorkers
      .filter((v): v is NonNullable<typeof v> => v !== null)
      .map((worker) => ({
        ...worker,
        status: worker.enabled && workerBroker.isOnline(worker.id) ? 'online' : 'offline',
      }));
    return res.type('html').send(
      workersPage({
        workers,
        profiles: profiles.filter((p): p is NonNullable<typeof p> => p !== null),
        checkingWorkerId: String(req.query.check || ''),
        enrollment: consumeWorkerEnrollment(req),
        workerInstallUrl: `${mcpConfig.publicBaseUrl}/worker/install.sh`,
        csrfToken: csrf(req),
        ...consumeFlash(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/admin/workers/enrollment', requireDataStore, async (req, res) => {
  try {
    const ttlSeconds = Math.max(
      60,
      Math.min(Number(formString(req.body, 'ttl_seconds')) || 600, 3600),
    );
    const enrollment = await workerRepo.createEnrollmentToken({ ttlSeconds });
    setWorkerEnrollment(req, enrollment);
    setFlash(req, 'success', 'One-time worker enrollment token created.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/admin/workers');
});

router.post('/admin/workers/profiles', requireDataStore, async (req, res) => {
  try {
    await requireActiveAdminWorker(formString(req.body, 'worker_id'));
    await workerRepo.createProfile({
      name: formString(req.body, 'name'),
      description: formString(req.body, 'description'),
      worker_id: formString(req.body, 'worker_id'),
      enabled: formFlag(req.body, 'enabled'),
    });
    setFlash(req, 'success', 'Execution target created through the active Worker.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/admin/workers');
});

router.post('/admin/workers/profiles/:id/delete', requireDataStore, async (req, res) => {
  try {
    const existing = await workerRepo.findAdminProfileById(String(req.params.id));
    if (!existing || !(await workerRepo.deleteProfile(existing.id)))
      throw new Error('Execution target not found.');
    setFlash(req, 'success', 'Execution target deleted. The Worker remains enrolled.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/admin/workers');
});

router.post('/admin/workers/:id/:action', requireDataStore, async (req, res) => {
  try {
    const worker = await workerRepo.findWorkerById(String(req.params.id));
    if (!worker) throw new Error('Worker not found.');
    if (String(req.params.action) === 'remove') {
      await workerLifecycleService.decommission(worker, {
        actorId: `admin:${req.session?.username || 'admin'}`,
      });
      setFlash(
        req,
        'success',
        'Worker removed remotely. mcp_worker Worker was uninstalled from the target machine and its server record was deleted.',
      );
      return res.redirect('/admin/workers');
    }
    if (String(req.params.action) === 'force-remove') {
      await workerLifecycleService.forceRemove(worker, {
        actorId: `admin:${req.session?.username || 'admin'}`,
      });
      setFlash(
        req,
        'success',
        'Worker force deleted from mcp_worker. Local Worker files may still remain on the target machine.',
      );
      return res.redirect('/admin/workers');
    }
    if (String(req.params.action) === 'edit') {
      await workerRepo.updateWorkerName(worker.id, formString(req.body, 'name'));
      setFlash(req, 'success', 'Worker name updated.');
      return res.redirect('/admin/workers');
    }
    if (!['enable', 'disable'].includes(String(req.params.action)))
      throw new Error('Unknown worker action.');
    const enabled = String(req.params.action) === 'enable';
    await workerRepo.setWorkerEnabled(worker.id, enabled);
    if (!enabled) workerBroker.disconnect(worker.id);
    setFlash(
      req,
      'success',
      enabled ? 'Worker enabled. Checking outbound connection…' : 'Worker disabled.',
    );
    if (enabled) return res.redirect(`/admin/workers?check=${encodeURIComponent(worker.id)}`);
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/admin/workers');
});

router.get('/admin/clients', requireDataStore, async (req, res, next) => {
  try {
    return res.type('html').send(
      clientsPage({
        clients: await clientList(),
        mcpUrl: mcpConfig.resourceUrl,
        csrfToken: csrf(req),
        secret: consumeOneTimeSecret(req),
        firstCall: ['local', '1'].includes(String(req.query.first_call || ''))
          ? String(req.query.first_call || '')
          : '',
        ...consumeFlash(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get('/admin/audit', requireDataStore, async (req, res, next) => {
  try {
    const filters = {
      query: String(req.query.q || '')
        .trim()
        .slice(0, 160),
      clientId: String(req.query.client_id || '')
        .trim()
        .slice(0, 200),
      toolName: String(req.query.tool_name || '')
        .trim()
        .slice(0, 160),
      result: String(req.query.result || '')
        .trim()
        .toUpperCase(),
    };
    if (!['', 'SUCCESS', 'DENIED', 'ERROR'].includes(filters.result)) filters.result = '';
    const allowedPageSizes = [20, 50, 100];
    const requestedPageSize = Number.parseInt(String(req.query.per_page || ''), 10);
    const perPage = allowedPageSizes.includes(requestedPageSize) ? requestedPageSize : 20;
    const total = await oauthRepo.countAuditLogs(filters);
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(
      Math.max(1, Number.parseInt(String(req.query.page || ''), 10) || 1),
      totalPages,
    );
    const [logs, clients, toolNames] = await Promise.all([
      oauthRepo.listAuditLogs({ ...filters, limit: perPage, offset: (page - 1) * perPage }),
      clientList(),
      oauthRepo.listAuditToolNames(),
    ]);
    return res.type('html').send(
      auditPage({
        logs: logs.map((row) => ({
          ...row,
          id: typeof row.id === 'string' ? row.id : '',
          result: typeof row.result === 'string' ? row.result : '',
        })),
        clients,
        toolNames: toolNames.filter((name): name is string => typeof name === 'string'),
        filters,
        page,
        perPage,
        total,
        totalPages,
        csrfToken: csrf(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get('/admin/audit/:id', requireDataStore, async (req, res, next) => {
  try {
    const id = String(String(req.params.id) || '')
      .trim()
      .slice(0, 128);
    const log = id ? await oauthRepo.findAuditLogById(id) : null;
    if (!log)
      return res.status(404).json({ error: 'Audit event not found.', code: 'AUDIT_NOT_FOUND' });
    return res.json({
      id: log.id,
      request_id: log.request_id,
      client_id: log.client_id,
      client_display_name: log.client_display_name,
      principal_id: log.principal_id,
      actor_id: log.actor_id,
      mcp_method: log.mcp_method,
      tool_name: log.tool_name,
      result: log.result,
      http_status: log.http_status,
      duration_ms: log.duration_ms,
      created_at: log.created_at,
      request_payload: log.request_payload,
      response_payload: log.response_payload,
      request_truncated: Boolean(log.request_truncated),
      response_truncated: Boolean(log.response_truncated),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/admin/clients', requireDataStore, async (req, res) => {
  try {
    const redirectUris = String(formString(req.body, 'redirect_uris') || '')
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
    const scopes = formList(req.body, 'scopes')
      .map((scope) => scope.trim())
      .filter(Boolean);
    const result = await oauthService.registerClient({
      displayName: formString(req.body, 'display_name'),
      redirectUris,
      allowedScopes: scopes,
    });
    if (!result.client) throw new Error('OAuth client creation returned no client.');
    setOneTimeSecret(req, { clientId: result.client.client_id, clientSecret: result.rawSecret });
    setFlash(req, 'success', 'OAuth client created.');
    return res.redirect('/admin/clients');
  } catch (error) {
    return res
      .status(400)
      .type('html')
      .send(
        clientsPage({
          clients: await clientList(),
          mcpUrl: mcpConfig.resourceUrl,
          csrfToken: csrf(req),
          error: routeError(error).message,
        }),
      );
  }
});

router.post('/admin/clients/:id/:action', requireDataStore, async (req, res) => {
  try {
    const client = await oauthRepo.findClientById(String(req.params.id));
    if (!client)
      return res.status(404).type('html').send(errorPage(404, 'OAuth client not found.'));
    const action = String(req.params.action);
    if (action === 'rotate') {
      const result = await oauthService.rotateClientSecret(client.client_id);
      setOneTimeSecret(req, { clientId: client.client_id, clientSecret: result.rawSecret });
      setFlash(req, 'success', 'Client secret rotated.');
      return res.redirect('/admin/clients');
    }
    if (action === 'enable') await oauthRepo.updateClientStatus(client.id, 'active');
    else if (action === 'disable') await oauthRepo.updateClientStatus(client.id, 'disabled');
    else if (action === 'revoke') {
      await oauthRepo.revokeAllTokensByClientId(client.client_id);
      await oauthRepo.updateClientStatus(client.id, 'revoked');
    } else if (action === 'delete') await oauthRepo.deleteClient(client.id);
    else return res.status(404).type('html').send(errorPage(404, 'Unknown client action.'));
    setFlash(req, 'success', `OAuth client ${action} completed.`);
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/admin/clients');
});

export = Object.assign(router, { requireAdmin, requireDataStore, telegramConfig });
