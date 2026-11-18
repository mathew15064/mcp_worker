import express, { type Request } from 'express';
import authService from '../services/authService';
import databaseManager from '../db/databaseManager';
import userRepository from '../repositories/userRepository';
import oauthRepo from '../repositories/mcpOAuthRepository';
import oauthService from '../services/mcpOAuthService';
import oauthRoutes from './mcpOAuthRoutes';
import workerRepo from '../repositories/workerRepository';
import workerBroker from '../services/workerConnectionBroker';
import runtimeSettings from '../services/runtimeSettingsService';
import userTelegramSettings from '../services/userTelegramSettingsService';
import mcpConfig from '../config/mcpConfig';
import { workerSignedReleaseReadiness } from '../services/workerReleaseGate';
import { TOOLS } from '../mcp/toolRegistry';
import { createRequire } from 'node:module';

const packageJson = createRequire(__filename)('../../package.json') as { version: string };
const router = express.Router();

// The JSON API reuses existing services and permission checks. UI action forms
// still POST to the original Express routes, retaining their CSRF and audit behavior.
function getFlash(req: Request) {
  const flash = {
    success: req.session?.flashSuccess || '',
    error: req.session?.flashError || '',
  };
  if (req.session) {
    delete req.session.flashSuccess;
    delete req.session.flashError;
  }
  return flash;
}

function oneTimeValue(req: Request, kind: 'oauthOneTimeSecret' | 'workerEnrollment') {
  const value = req.session?.[kind] || null;
  if (req.session) delete req.session[kind];
  return value;
}

function clientView(row: NonNullable<Awaited<ReturnType<typeof oauthRepo.listClients>>[number]>) {
  return {
    id: row.id,
    client_id: row.client_id,
    display_name: row.display_name,
    principal_id: row.principal_id,
    profile_id: row.profile_id,
    owner_user_id: row.owner_user_id,
    status: row.status,
    allowed_scopes: row.allowed_scopes,
    redirect_uris: row.redirect_uris,
    last_authorized_at: row.last_authorized_at,
    is_public: Boolean(row.is_public),
  };
}
function workerView(row: NonNullable<Awaited<ReturnType<typeof workerRepo.listWorkers>>[number]>) {
  return {
    id: row.id,
    name: row.name,
    owner_user_id: row.owner_user_id,
    owner_username: row.owner_username,
    enabled: Boolean(row.enabled),
    status: row.status,
    last_seen_at: row.last_seen_at,
    capabilities: row.capabilities,
    hosted_isolated: Boolean(row.hosted_isolated),
  };
}
async function withPresence(workers: Awaited<ReturnType<typeof workerRepo.listWorkers>>) {
  return Promise.all(
    workers
      .filter((w): w is NonNullable<typeof w> => w !== null)
      .map(async (w) => ({
        ...workerView(w),
        connected: Boolean(w.enabled && (await workerBroker.isOnlineDistributed(w.id))),
      })),
  );
}

function runtimeView() {
  return {
    version: packageJson.version,
    gitSha: process.env.MCP_WORKER_GIT_SHA || null,
    buildTime: process.env.MCP_WORKER_BUILD_TIME || null,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    nodeEnv: process.env.NODE_ENV || 'development',
    toolCount: TOOLS.length,
  };
}

function telegramView() {
  return {
    enabled: runtimeSettings.bool('telegram.enabled', false),
    chatId: runtimeSettings.get('telegram.chat_id', ''),
    hasToken: Boolean(runtimeSettings.get('telegram.bot_token', '')),
  };
}

function mcpView() {
  return {
    enabled: mcpConfig.enabled,
    publicBaseUrl: mcpConfig.publicBaseUrl,
    accessTokenTtlSeconds: mcpConfig.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: mcpConfig.refreshTokenTtlSeconds,
    authCodeTtlSeconds: mcpConfig.authCodeTtlSeconds,
    rateLimitPerMinute: mcpConfig.rateLimitPerMinute,
  };
}
function getView(req: Request) {
  const raw = typeof req.query.view === 'string' ? req.query.view : '/';
  const url = new URL(
    raw.startsWith('/') && !raw.startsWith('//') ? raw : '/',
    'https://localhost',
  );
  return { pathname: url.pathname, query: url.searchParams };
}

router.get('/state', async (req, res, next) => {
  res.set('Cache-Control', 'no-store, private');
  res.set('Vary', 'Cookie');
  try {
    const { pathname, query } = getView(req);
    const identity = await authService.currentIdentity(req.session);
    const role = identity?.role || null;
    const needsAdmin = pathname === '/admin' || pathname.startsWith('/admin/');
    const needsUser = pathname === '/account' || pathname.startsWith('/account/');
    const needsConsent = pathname === '/oauth/authorize';
    if ((needsAdmin && role !== 'admin') || (needsUser && role !== 'user'))
      return res
        .status(401)
        .json({ error: 'Sign in with the required account to continue.', code: 'LOGIN_REQUIRED' });
    if (needsConsent && !identity)
      return res
        .status(401)
        .json({ error: 'Sign in to authorize this OAuth client.', code: 'LOGIN_REQUIRED' });

    const data: Record<string, unknown> = {};
    const result: Record<string, unknown> = {
      role,
      csrfToken: req.session?.csrfToken || '',
      identity: identity
        ? {
            id: identity.id,
            username: identity.username,
            role: identity.role,
            display_name: 'display_name' in identity ? identity.display_name : identity.username,
            email: 'email' in identity ? identity.email : null,
            principal_id: 'principal_id' in identity ? identity.principal_id : null,
            profile_id: 'profile_id' in identity ? identity.profile_id : null,
            status: 'status' in identity ? identity.status : 'active',
          }
        : null,
      registrationEnabled: runtimeSettings.bool('registration.enabled', true),
      endpoint: mcpConfig.resourceUrl,
      storage: databaseManager.status(),
      runtime: runtimeView(),
      data,
    };

    if (needsConsent && identity) {
      const get = (key: string) => query.get(key) || undefined;
      const validated = await oauthService.validateAuthorizeRequest({
        clientId: get('client_id'),
        redirectUri: get('redirect_uri'),
        responseType: get('response_type'),
        scope: get('scope'),
        state: get('state'),
        codeChallenge: get('code_challenge'),
        codeChallengeMethod: get('code_challenge_method'),
        resource: get('resource'),
      });
      if (!oauthRoutes.canAuthorizeClient(identity, validated.client))
        return res.status(403).json({ error: 'This OAuth client belongs to another identity.' });
      data.consent = {
        clientName: validated.client.display_name,
        redirectUri: validated.redirectUri,
        scopes: validated.scopes,
        resource: validated.resource,
        state: validated.state || '',
        client_id: validated.client.client_id,
        redirect_uri: validated.redirectUri,
        scope: validated.scopes.join(' '),
        code_challenge: validated.codeChallenge,
        code_challenge_method: validated.codeChallengeMethod,
      };
    }

    if (role === 'admin' && needsAdmin) {
      if (pathname === '/admin' || pathname === '/admin/onboarding') {
        const [clients, workers, profiles, firstCall] = await Promise.all([
          oauthRepo.listClients(),
          workerRepo.listAdminWorkers(),
          workerRepo.listAdminProfiles(),
          oauthRepo.hasAdminRuntimeCall(),
        ]);
        data.clients = clients
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .map(clientView);
        data.workers = await withPresence(workers);
        data.profiles = profiles.filter((p) => p !== null);
        data.firstCall = firstCall;
        data.telegram = telegramView();
      }
      if (pathname === '/admin/users') {
        data.users = await userRepository.list();
        data.registrationEnabled = runtimeSettings.bool('registration.enabled', true);
        data.hostedExecutionEnabled = runtimeSettings.bool('hosted.execution.enabled', false);
      }
      if (pathname === '/admin/clients') {
        data.clients = (await oauthRepo.listClients())
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .map(clientView);
        result.secret = oneTimeValue(req, 'oauthOneTimeSecret');
      }
      if (pathname === '/admin/workers') {
        data.workers = await withPresence(await workerRepo.listAdminWorkers());
        data.release = workerSignedReleaseReadiness();
        result.enrollment = oneTimeValue(req, 'workerEnrollment');
      }
      if (pathname === '/admin/audit') {
        const filters = {
          query: (query.get('q') || '').slice(0, 160),
          clientId: (query.get('client_id') || '').slice(0, 200),
          toolName: (query.get('tool_name') || '').slice(0, 160),
          result: (query.get('result') || '').toUpperCase(),
        };
        if (!['', 'SUCCESS', 'DENIED', 'ERROR'].includes(filters.result)) filters.result = '';
        const page = Math.max(
          1,
          Math.min(100000, Number.parseInt(query.get('page') || '1', 10) || 1),
        );
        const limit = 20;
        const [logs, total, clients, tools] = await Promise.all([
          oauthRepo.listAuditLogs({ ...filters, limit, offset: (page - 1) * limit }),
          oauthRepo.countAuditLogs(filters),
          oauthRepo.listClients(),
          oauthRepo.listAuditToolNames(),
        ]);
        data.logs = logs;
        data.total = total;
        data.page = page;
        data.perPage = limit;
        data.filters = filters;
        data.clients = clients
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .map(clientView);
        data.toolNames = tools;
      }
      if (pathname.startsWith('/admin/settings') || pathname === '/admin/telegram') {
        data.telegram = telegramView();
        data.mcp = mcpView();
      }
    }

    if (role === 'user' && needsUser) {
      const ownerId = identity?.id || '';
      if (pathname === '/account' || pathname === '/account/connect')
        data.clientCount = (await oauthRepo.listClientsByOwner(ownerId)).length;
      if (pathname === '/account/tools') {
        const profiles = await workerRepo.listProfilesByOwner(ownerId);
        data.hasWorker =
          runtimeSettings.bool('hosted.execution.enabled', false) &&
          profiles.some((p) => p !== null && p.enabled && p.hosted_isolated);
        data.tools = TOOLS.map((t) => ({ name: t.name, description: t.description }));
      }
      if (pathname === '/account/activity')
        data.logs = await oauthRepo.listAuditLogsForOwner(ownerId, 100);
      if (pathname === '/account/clients') {
        data.clients = (await oauthRepo.listClientsByOwner(ownerId))
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .map(clientView);
        result.secret = oneTimeValue(req, 'oauthOneTimeSecret');
      }
      if (pathname === '/account/workers') {
        data.workers = await withPresence(await workerRepo.listWorkersByOwner(ownerId));
        data.release = workerSignedReleaseReadiness();
        result.enrollment = oneTimeValue(req, 'workerEnrollment');
      }
      if (pathname === '/account/telegram') data.telegram = await userTelegramSettings.get(ownerId);
    }

    if (identity && (needsAdmin || needsUser)) result.flash = getFlash(req);
    return res.json(result);
  } catch (error) {
    // Invalid browser OAuth requests retain their 4xx contract; never turn
    // a rejected PKCE/client/redirect validation into a generic HTTP 500.
    const failure =
      error && typeof error === 'object'
        ? (error as { status?: number; error?: string; message?: string })
        : {};
    if (
      typeof req.query.view === 'string' &&
      req.query.view.startsWith('/oauth/authorize') &&
      typeof failure.status === 'number' &&
      failure.status >= 400 &&
      failure.status < 500
    ) {
      return res.status(failure.status).json({
        error: failure.message || 'Invalid authorization request.',
        code: failure.error || 'INVALID_OAUTH_REQUEST',
      });
    }
    return next(error);
  }
});

export = router;
