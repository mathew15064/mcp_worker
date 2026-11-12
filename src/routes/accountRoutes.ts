import express, { type Request, type Response, type NextFunction } from 'express';
import { routeError } from '../http/domainErrors';
import { formString, formFlag } from '../http/requestContracts';
import pages from '../http/pages';
declare module 'express-serve-static-core' {
  interface Request {
    /** Present only after requireUser middleware succeeds. */
    currentUser: {
      id: string;
      role: string;
      principal_id: string;
      profile_id: string | null;
      session_version?: number;
      username?: string;
    };
  }
}
import authRoutes from './authRoutes';
const { currentIdentity } = authRoutes;
import oauthRepo from '../repositories/mcpOAuthRepository';
import workerRepo from '../repositories/workerRepository';
import workerBroker from '../services/workerConnectionBroker';
import workerLifecycle from '../services/workerLifecycleService';
import oauthService from '../services/mcpOAuthService';
import userService from '../services/userService';
import userTelegramSettings from '../services/userTelegramSettingsService';
import telegramService from '../services/telegramService';
import mcpConfig from '../config/mcpConfig';
const { accountClientsPage, accountTelegramPage, workersPage, errorPage } = pages;

const router = express.Router();

function csrf(req: Request) {
  return req.session?.csrfToken || '';
}
function setFlash(req: Request, kind: 'error' | 'success', message: string) {
  if (req.session) req.session[kind === 'error' ? 'flashError' : 'flashSuccess'] = message;
}
function consumeFlash(req: Request) {
  const value = { success: req.session?.flashSuccess || '', error: req.session?.flashError || '' };
  if (req.session) {
    delete req.session.flashSuccess;
    delete req.session.flashError;
  }
  return value;
}
function setOneTimeSecret(req: Request, secret: { clientId: string; clientSecret: string }) {
  if (req.session) req.session.oauthOneTimeSecret = secret;
}
function consumeOneTimeSecret(req: Request) {
  const value = req.session?.oauthOneTimeSecret || null;
  if (req.session) delete req.session.oauthOneTimeSecret;
  return value;
}
function setWorkerEnrollment(req: Request, enrollment: { token: string; expires_at?: string }) {
  if (req.session) req.session.workerEnrollment = enrollment;
}
function consumeWorkerEnrollment(req: Request) {
  const value = req.session?.workerEnrollment || null;
  if (req.session) delete req.session.workerEnrollment;
  return value;
}
function accountReturnTo(req: Request) {
  const value = String(req.body?.return_to || '');
  if (
    !value.startsWith('/account/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value === '/account/profile'
  )
    return '/account/clients';
  try {
    const url = new URL(value, 'http://localhost');
    return url.origin === 'http://localhost' && url.pathname.startsWith('/account/')
      ? `${url.pathname}${url.search}`
      : '/account/clients';
  } catch (_) {
    return '/account/clients';
  }
}

async function requireUser(req: Request, res: Response, next: NextFunction) {
  try {
    const identity = await currentIdentity(req);
    if (
      identity?.role === 'user' &&
      'principal_id' in identity &&
      typeof identity.principal_id === 'string'
    ) {
      req.currentUser = {
        ...identity,
        principal_id: identity.principal_id,
        profile_id: identity.profile_id,
      };
      return next();
    }
    if (req.session) req.session.returnTo = req.originalUrl;
    return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  } catch (error) {
    next(error);
  }
}

async function requireActiveOwnedWorker(workerId: string, ownerUserId: string) {
  const worker = await workerRepo.findWorkerByIdForOwner(workerId, ownerUserId);
  if (!worker)
    throw Object.assign(new Error('Worker not found.'), { code: 'WORKER_NOT_FOUND', status: 404 });
  if (!worker.enabled || !(await workerBroker.isOnlineDistributed(worker.id))) {
    throw Object.assign(new Error('Execution targets require an enabled, online Worker.'), {
      code: 'WORKER_NOT_ONLINE',
      status: 409,
    });
  }
  return worker;
}

router.use('/account', requireUser, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/account', (req, res) => res.redirect('/account/clients'));

router.get('/account/clients', async (req, res, next) => {
  try {
    return res.type('html').send(
      accountClientsPage({
        user: req.currentUser,
        clients: (await oauthRepo.listClientsByOwner(req.currentUser.id)).filter(
          (client): client is NonNullable<typeof client> => client !== null,
        ),
        mcpUrl: mcpConfig.resourceUrl,
        csrfToken: csrf(req),
        secret: consumeOneTimeSecret(req),
        ...consumeFlash(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/account/clients', async (req, res) => {
  try {
    const redirectUris = String(formString(req.body, 'redirect_uris') || '')
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
    const result = await oauthService.registerClient({
      displayName: formString(req.body, 'display_name'),
      principalId: req.currentUser.principal_id,
      profileId: req.currentUser.profile_id,
      ownerUserId: req.currentUser.id,
      redirectUris,
      allowedScopes: ['bot_report.read', 'bot_report.terminal', 'offline_access'],
    });
    if (!result.client) throw new Error('OAuth client creation returned no client.');
    setOneTimeSecret(req, { clientId: result.client.client_id, clientSecret: result.rawSecret });
    setFlash(req, 'success', 'OAuth client created.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/account/clients');
});

router.post('/account/clients/:id/:action', async (req, res) => {
  try {
    const client = await oauthRepo.findClientByIdForOwner(req.params.id, req.currentUser.id);
    if (!client)
      return res.status(404).type('html').send(errorPage(404, 'OAuth client not found.'));
    const action = req.params.action;
    if (action === 'rotate') {
      const result = await oauthService.rotateClientSecret(client.client_id);
      setOneTimeSecret(req, { clientId: client.client_id, clientSecret: result.rawSecret });
      setFlash(req, 'success', 'Client secret rotated.');
      return res.redirect('/account/clients');
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
  return res.redirect('/account/clients');
});

router.get('/account/workers/connection-status', async (req, res, next) => {
  try {
    const workers = (await workerRepo.listWorkersByOwner(req.currentUser.id)).filter(
      (item): item is NonNullable<typeof item> => item !== null,
    );
    const checkId = String(req.query.check || '');
    const target = workers.find((worker) => worker.id === checkId);
    const probe =
      target?.enabled && workerBroker.isOnline(checkId)
        ? await workerBroker.probeConnection(checkId)
        : null;
    return res.json({
      workers: await Promise.all(
        workers.map(async (worker) => ({
          id: worker.id,
          enabled: worker.enabled,
          connected: worker.enabled && (await workerBroker.isOnlineDistributed(worker.id)),
          last_seen_at: worker.last_seen_at,
        })),
      ),
      probe: probe ? { id: checkId, ...probe } : null,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/account/workers', async (req, res, next) => {
  try {
    return res.type('html').send(
      workersPage({
        workers: await Promise.all(
          (await workerRepo.listWorkersByOwner(req.currentUser.id))
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .map(async (worker) => ({
              ...worker,
              status:
                worker.enabled && (await workerBroker.isOnlineDistributed(worker.id))
                  ? ('online' as const)
                  : ('offline' as const),
            })),
        ),
        profiles: (await workerRepo.listProfilesByOwner(req.currentUser.id)).filter(
          (profile): profile is NonNullable<typeof profile> => profile !== null,
        ),
        checkingWorkerId: String(req.query.check || ''),
        enrollment: consumeWorkerEnrollment(req),
        workerInstallUrl: `${mcpConfig.publicBaseUrl}/worker/install.sh`,
        routeBase: '/account/workers',
        accountUser: req.currentUser,
        csrfToken: csrf(req),
        ...consumeFlash(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/account/workers/enrollment', async (req, res) => {
  try {
    const ttlSeconds = Math.max(
      60,
      Math.min(Number(formString(req.body, 'ttl_seconds')) || 600, 3600),
    );
    const enrollment = await workerRepo.createEnrollmentToken({
      ttlSeconds,
      ownerUserId: req.currentUser.id,
    });
    setWorkerEnrollment(req, enrollment);
    setFlash(req, 'success', 'One-time worker enrollment token created.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/account/workers');
});

router.post('/account/workers/:id/:action', async (req, res) => {
  try {
    const action = req.params.action;
    const worker = await workerRepo.findWorkerByIdForOwner(req.params.id, req.currentUser.id);
    if (!worker) return res.status(404).type('html').send(errorPage(404, 'Worker not found.'));
    if (action === 'remove') {
      await workerLifecycle.decommission(worker, {
        actorId: req.currentUser.principal_id,
        ownerUserId: req.currentUser.id,
      });
      setFlash(
        req,
        'success',
        'Worker removed remotely. mcp_worker Worker was uninstalled from the target machine and its server record was deleted.',
      );
      return res.redirect('/account/workers');
    }
    if (action === 'force-remove') {
      await workerLifecycle.forceRemove(worker, {
        actorId: req.currentUser.principal_id,
        ownerUserId: req.currentUser.id,
      });
      setFlash(
        req,
        'success',
        'Worker force deleted from mcp_worker. Local Worker files may still remain on the target machine.',
      );
      return res.redirect('/account/workers');
    }
    if (action === 'edit') {
      await workerRepo.updateWorkerName(worker.id, formString(req.body, 'name'), {
        ownerUserId: req.currentUser.id,
      });
      setFlash(req, 'success', 'Worker name updated.');
      return res.redirect('/account/workers');
    }
    if (!['enable', 'disable'].includes(action))
      return res.status(404).type('html').send(errorPage(404, 'Unknown worker action.'));
    const enabled = action === 'enable';
    const updated = await workerRepo.setWorkerEnabled(worker.id, enabled, {
      ownerUserId: req.currentUser.id,
    });
    if (!updated) throw new Error('Worker status could not be updated.');
    if (!enabled) workerBroker.disconnect(updated.id);
    setFlash(
      req,
      'success',
      enabled ? 'Worker enabled. Checking outbound connection…' : 'Worker disabled.',
    );
    if (enabled) return res.redirect(`/account/workers?check=${encodeURIComponent(updated.id)}`);
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/account/workers');
});

router.post('/account/workers/profiles', async (req, res) => {
  try {
    await requireActiveOwnedWorker(formString(req.body, 'worker_id'), req.currentUser.id);
    await workerRepo.createProfile(
      {
        name: formString(req.body, 'name'),
        description: formString(req.body, 'description'),
        worker_id: formString(req.body, 'worker_id'),
        enabled: formFlag(req.body, 'enabled'),
      },
      { ownerUserId: req.currentUser.id },
    );
    setFlash(req, 'success', 'Execution target created through the active Worker.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/account/workers');
});

router.post('/account/workers/profiles/:id/delete', async (req, res) => {
  try {
    const removed = await workerRepo.deleteProfile(req.params.id, {
      ownerUserId: req.currentUser.id,
    });
    if (!removed)
      return res.status(404).type('html').send(errorPage(404, 'Worker Profile not found.'));
    setFlash(req, 'success', 'Worker Profile deleted.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/account/workers');
});

router.get('/account/telegram', async (req, res, next) => {
  try {
    return res.type('html').send(
      accountTelegramPage({
        user: req.currentUser,
        config: await userTelegramSettings.get(req.currentUser.id),
        csrfToken: csrf(req),
        ...consumeFlash(req),
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.post('/account/telegram', async (req, res) => {
  try {
    await userTelegramSettings.save(req.currentUser.id, {
      enabled: formFlag(req.body, 'enabled'),
      chatId: formString(req.body, 'chat_id'),
      botToken: formString(req.body, 'bot_token'),
    });
    setFlash(req, 'success', 'Your Telegram settings were saved separately from Admin Telegram.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect('/account/telegram');
});

router.post('/account/telegram/test', async (req, res) => {
  try {
    const credentials = await userTelegramSettings.credentials(req.currentUser.id);
    await telegramService.sendTest(credentials.token, credentials.chatId);
    setFlash(req, 'success', 'Telegram test message delivered successfully.');
  } catch (error) {
    setFlash(req, 'error', `Telegram test failed: ${routeError(error).message}`);
  }
  return res.redirect('/account/telegram');
});

router.get('/account/profile', (req, res) => res.redirect('/account/clients'));

router.post('/account/profile', async (req, res) => {
  const returnTo = accountReturnTo(req);
  try {
    const updated = await userService.updateProfile(req.currentUser.id, {
      displayName: formString(req.body, 'display_name'),
      email: formString(req.body, 'email'),
    });
    if (!updated) throw new Error('Profile update returned no user.');
    req.session.username = updated.username;
    setFlash(req, 'success', 'Profile updated.');
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
  }
  return res.redirect(returnTo);
});

router.post('/account/password', async (req, res, next) => {
  const returnTo = accountReturnTo(req);
  try {
    await userService.changePassword(req.currentUser.id, formString(req.body, 'password'));
    return req.session.destroy((error) => (error ? next(error) : res.redirect('/login')));
  } catch (error) {
    setFlash(req, 'error', routeError(error).message);
    return res.redirect(returnTo);
  }
});

export = Object.assign(router, { requireUser });
