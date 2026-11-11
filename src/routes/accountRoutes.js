const express = require('express');
const { currentIdentity } = require('./authRoutes');
const oauthRepo = require('../repositories/mcpOAuthRepository');
const workerRepo = require('../repositories/workerRepository');
const workerBroker = require('../services/workerConnectionBroker');
const workerExecutionService = require('../services/workerExecutionService');
const terminalNonces = require('../services/terminalNonceService');
const terminalOrigins = require('../services/terminalPublicOriginService');
const workerLifecycle = require('../services/workerLifecycleService');
const oauthService = require('../services/mcpOAuthService');
const userService = require('../services/userService');
const userTelegramSettings = require('../services/userTelegramSettingsService');
const telegramService = require('../services/telegramService');
const mcpConfig = require('../config/mcpConfig');
const { accountClientsPage, accountSshProfilesPage, accountTelegramPage, terminalConsolePage, workersPage, errorPage } = require('../http/pages');

const router = express.Router();

function csrf(req) { return req.session?.csrfToken || ''; }
function setFlash(req, kind, message) { if (req.session) req.session[kind === 'error' ? 'flashError' : 'flashSuccess'] = message; }
function consumeFlash(req) {
  const value = { success: req.session?.flashSuccess || '', error: req.session?.flashError || '' };
  if (req.session) {
    delete req.session.flashSuccess;
    delete req.session.flashError;
  }
  return value;
}
function setOneTimeSecret(req, secret) { if (req.session) req.session.oauthOneTimeSecret = secret; }
function consumeOneTimeSecret(req) { const value = req.session?.oauthOneTimeSecret || null; if (req.session) delete req.session.oauthOneTimeSecret; return value; }
function setWorkerEnrollment(req, enrollment) { if (req.session) req.session.workerEnrollment = enrollment; }
function consumeWorkerEnrollment(req) { const value = req.session?.workerEnrollment || null; if (req.session) delete req.session.workerEnrollment; return value; }
function accountReturnTo(req) {
  const value = String(req.body?.return_to || '');
  if (!value.startsWith('/account/') || value.startsWith('//') || value.includes('\\') || value === '/account/profile') return '/account/clients';
  try {
    const url = new URL(value, 'http://localhost');
    return url.origin === 'http://localhost' && url.pathname.startsWith('/account/') ? `${url.pathname}${url.search}` : '/account/clients';
  } catch (_) { return '/account/clients'; }
}

async function requireUser(req, res, next) {
  try {
    const identity = await currentIdentity(req);
    if (identity?.role === 'user') {
      req.currentUser = identity;
      return next();
    }
    if (req.session) req.session.returnTo = req.originalUrl;
    return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  } catch (error) { next(error); }
}

async function requireActiveOwnedWorker(workerId, ownerUserId) {
  const worker = await workerRepo.findWorkerByIdForOwner(workerId, ownerUserId);
  if (!worker) throw Object.assign(new Error('Worker not found.'), { code: 'WORKER_NOT_FOUND', status: 404 });
  if (!worker.enabled || worker.status !== 'online' || !workerBroker.isOnline(worker.id)) {
    throw Object.assign(new Error('SSH Profiles can only bind to an enabled Worker that is currently online.'), { code: 'WORKER_NOT_ONLINE', status: 409 });
  }
  return worker;
}

router.use('/account', requireUser, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/account', (req, res) => res.redirect('/account/clients'));

router.get('/account/clients', async (req, res, next) => {
  try {
    return res.type('html').send(accountClientsPage({
      user: req.currentUser,
      clients: await oauthRepo.listClientsByOwner(req.currentUser.id),
      mcpUrl: mcpConfig.resourceUrl,
      csrfToken: csrf(req),
      secret: consumeOneTimeSecret(req),
      ...consumeFlash(req)
    }));
  } catch (error) { next(error); }
});

router.post('/account/clients', async (req, res) => {
  try {
    const redirectUris = String(req.body.redirect_uris || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    const result = await oauthService.registerClient({
      displayName: req.body.display_name,
      principalId: req.currentUser.principal_id,
      profileId: req.currentUser.profile_id,
      ownerUserId: req.currentUser.id,
      redirectUris,
      allowedScopes: ['bot_report.read', 'bot_report.terminal', 'offline_access']
    });
    setOneTimeSecret(req, { clientId: result.client.client_id, clientSecret: result.rawSecret });
    setFlash(req, 'success', 'OAuth client created.');
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/clients');
});

router.post('/account/clients/:id/:action', async (req, res) => {
  try {
    const client = await oauthRepo.findClientByIdForOwner(req.params.id, req.currentUser.id);
    if (!client) return res.status(404).type('html').send(errorPage(404, 'OAuth client not found.'));
    const action = req.params.action;
    if (action === 'rotate') {
      const result = await oauthService.rotateClientSecret(client.client_id);
      setOneTimeSecret(req, { clientId: client.client_id, clientSecret: result.rawSecret });
      setFlash(req, 'success', 'Client secret rotated.');
      return res.redirect('/account/clients');
    }
    if (action === 'enable') await oauthRepo.updateClientStatus(client.id, 'active');
    else if (action === 'disable') await oauthRepo.updateClientStatus(client.id, 'disabled');
    else if (action === 'revoke') { await oauthRepo.revokeAllTokensByClientId(client.client_id); await oauthRepo.updateClientStatus(client.id, 'revoked'); }
    else if (action === 'delete') await oauthRepo.deleteClient(client.id);
    else return res.status(404).type('html').send(errorPage(404, 'Unknown client action.'));
    setFlash(req, 'success', `OAuth client ${action} completed.`);
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/clients');
});

router.get('/account/workers/connection-status', async (req, res, next) => {
  try {
    const workers = await workerRepo.listWorkersByOwner(req.currentUser.id);
    const checkId = String(req.query.check || '');
    const target = workers.find(worker => worker.id === checkId);
    const probe = target?.enabled && workerBroker.isOnline(checkId)
      ? await workerBroker.probeConnection(checkId) : null;
    return res.json({
      workers: workers.map(worker => ({
        id: worker.id,
        enabled: worker.enabled,
        connected: worker.enabled && workerBroker.isOnline(worker.id),
        last_seen_at: worker.last_seen_at
      })),
      probe: probe ? { id: checkId, ...probe } : null
    });
  } catch (error) { next(error); }
});

router.get('/account/workers', async (req, res, next) => {
  try {
    return res.type('html').send(workersPage({
      workers: (await workerRepo.listWorkersByOwner(req.currentUser.id)).map(worker => ({
        ...worker,
        status: worker.enabled && workerBroker.isOnline(worker.id) ? 'online' : 'offline'
      })),
      profiles: await workerRepo.listProfilesByOwner(req.currentUser.id),
      checkingWorkerId: String(req.query.check || ''),
      enrollment: consumeWorkerEnrollment(req),
      workerInstallUrl: `${mcpConfig.publicBaseUrl}/worker/install.sh`,
      routeBase: '/account/workers',
      accountUser: req.currentUser,
      csrfToken: csrf(req),
      ...consumeFlash(req)
    }));
  } catch (error) { next(error); }
});

router.post('/account/workers/enrollment', async (req, res) => {
  try {
    const ttlSeconds = Math.max(60, Math.min(Number(req.body.ttl_seconds) || 600, 3600));
    const enrollment = await workerRepo.createEnrollmentToken({ ttlSeconds, ownerUserId: req.currentUser.id });
    setWorkerEnrollment(req, enrollment);
    setFlash(req, 'success', 'One-time worker enrollment token created.');
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/workers');
});

router.post('/account/workers/:id/:action', async (req, res) => {
  try {
    const action = req.params.action;
    const worker = await workerRepo.findWorkerByIdForOwner(req.params.id, req.currentUser.id);
    if (!worker) return res.status(404).type('html').send(errorPage(404, 'Worker not found.'));
    if (action === 'remove') {
      await workerLifecycle.decommission(worker, { actorId: req.currentUser.principal_id, ownerUserId: req.currentUser.id });
      setFlash(req, 'success', 'Worker removed remotely. Bot Report Worker was uninstalled from the target machine and its server record was deleted.');
      return res.redirect('/account/workers');
    }
    if (action === 'force-remove') {
      await workerLifecycle.forceRemove(worker, { actorId: req.currentUser.principal_id, ownerUserId: req.currentUser.id });
      setFlash(req, 'success', 'Worker force deleted from Bot Report. Local Worker files may still remain on the target machine.');
      return res.redirect('/account/workers');
    }
    if (action === 'edit') {
      await workerRepo.updateWorkerName(worker.id, req.body.name, { ownerUserId: req.currentUser.id });
      setFlash(req, 'success', 'Worker name updated.');
      return res.redirect('/account/workers');
    }
    if (!['enable', 'disable'].includes(action)) return res.status(404).type('html').send(errorPage(404, 'Unknown worker action.'));
    const enabled = action === 'enable';
    const updated = await workerRepo.setWorkerEnabled(worker.id, enabled, { ownerUserId: req.currentUser.id });
    if (!enabled) workerBroker.disconnect(updated.id);
    setFlash(req, 'success', enabled ? 'Worker enabled. Checking outbound connection…' : 'Worker disabled.');
    if (enabled) return res.redirect(`/account/workers?check=${encodeURIComponent(updated.id)}`);
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/workers');
});

router.post('/account/workers/profiles', async (req, res) => {
  try {
    await requireActiveOwnedWorker(req.body.worker_id, req.currentUser.id);
    await workerRepo.createProfile({
      name: req.body.name,
      description: req.body.description,
      worker_id: req.body.worker_id,
      enabled: req.body.enabled
    }, { ownerUserId: req.currentUser.id });
    setFlash(req, 'success', 'SSH Profile created through the active Worker.');
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/ssh-profiles');
});

router.post('/account/workers/profiles/:id/delete', async (req, res) => {
  try {
    const removed = await workerRepo.deleteProfile(req.params.id, { ownerUserId: req.currentUser.id });
    if (!removed) return res.status(404).type('html').send(errorPage(404, 'Worker Profile not found.'));
    setFlash(req, 'success', 'Worker Profile deleted.');
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/ssh-profiles');
});

router.get('/account/ssh-profiles', async (req, res, next) => {
  try {
    const workers = (await workerRepo.listWorkersByOwner(req.currentUser.id)).map(worker => ({
      ...worker,
      status: worker.enabled && workerBroker.isOnline(worker.id) ? 'online' : 'offline'
    }));
    const workerById = new Map(workers.map(worker => [worker.id, worker]));
    const profiles = (await workerRepo.listProfilesByOwner(req.currentUser.id)).map(profile => {
      const liveWorker = workerById.get(profile.worker_id);
      return {
        ...profile,
        worker_status: liveWorker?.status || 'offline',
        worker_enabled: Boolean(liveWorker?.enabled)
      };
    });
    return res.type('html').send(accountSshProfilesPage({
      user: req.currentUser,
      profiles,
      workers,
      csrfToken: csrf(req),
      ...consumeFlash(req)
    }));
  } catch (error) { next(error); }
});

router.post('/account/ssh-profiles', async (req, res) => {
  try {
    await requireActiveOwnedWorker(req.body.worker_id, req.currentUser.id);
    await workerRepo.createProfile({
      name: req.body.name,
      description: req.body.description,
      worker_id: req.body.worker_id,
      enabled: req.body.enabled
    }, { ownerUserId: req.currentUser.id });
    setFlash(req, 'success', 'SSH Profile created through the active Worker.');
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/ssh-profiles');
});

router.post('/account/ssh-profiles/:id/update', async (req, res) => {
  try {
    const existing = await workerRepo.findProfileByIdForOwner(req.params.id, req.currentUser.id);
    if (!existing) return res.status(404).type('html').send(errorPage(404, 'SSH Profile not found.'));
    await requireActiveOwnedWorker(req.body.worker_id, req.currentUser.id);
    await workerRepo.updateProfile(existing.id, {
      name: req.body.name,
      description: req.body.description,
      worker_id: req.body.worker_id,
      enabled: req.body.enabled
    }, { ownerUserId: req.currentUser.id });
    setFlash(req, 'success', 'SSH Profile updated.');
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/ssh-profiles');
});

router.get('/account/ssh-profiles/:id/shell', async (req, res) => {
  const profile = await workerRepo.findProfileByIdForOwner(req.params.id, req.currentUser.id);
  if (!profile) return res.status(404).type('html').send(errorPage(404, 'SSH Profile not found.'));
  if (!profile.enabled || !workerBroker.isOnline(profile.worker_id)) {
    setFlash(req, 'error', 'The Worker must be online and this SSH Profile must be enabled before attaching a shell.');
    return res.redirect('/account/ssh-profiles');
  }
  return res.type('html').send(terminalConsolePage({ profile, accountUser: req.currentUser, routeBase: '/account/ssh-profiles', csrfToken: csrf(req) }));
});

router.post('/account/ssh-profiles/:id/test', async (req, res) => {
  const json = String(req.get('accept') || '').includes('application/json');
  try {
    const profile = await workerRepo.findProfileByIdForOwner(req.params.id, req.currentUser.id);
    if (!profile) throw Object.assign(new Error('SSH Profile not found.'), { code: 'PROFILE_NOT_FOUND', status: 404 });
    if (!profile.enabled) throw Object.assign(new Error('This SSH Profile is disabled.'), { code: 'PROFILE_DISABLED', status: 409 });
    await requireActiveOwnedWorker(profile.worker_id, req.currentUser.id);
    const startedAt = Date.now();
    const result = await workerExecutionService.testConnection(profile);
    const payload = { code: 'TEST_OK', message: 'Direct Worker shell is ready.', duration_ms: Date.now() - startedAt,
      pane_count: result.pane_count, target_pane: result.target_pane, pane_current_command: result.pane_current_command };
    if (json) return res.json(payload);
    setFlash(req, 'success', `${payload.message} (${payload.duration_ms} ms)`);
  } catch (error) {
    if (json) return res.status(error.status || 422).json({ code: error.code || 'WORKER_TEST_FAILED', message: error.message || 'Worker shell test failed.' });
    setFlash(req, 'error', error.message || 'Worker shell test failed.');
  }
  return res.redirect('/account/ssh-profiles');
});

router.post('/account/ssh-profiles/:id/session', async (req, res) => {
  try {
    const profile = await workerRepo.findProfileByIdForOwner(req.params.id, req.currentUser.id);
    if (!profile) return res.status(404).json({ code: 'PROFILE_NOT_FOUND', message: 'SSH Profile not found.' });
    if (!profile.enabled) return res.status(409).json({ code: 'PROFILE_DISABLED', message: 'This SSH Profile is disabled.' });
    await requireActiveOwnedWorker(profile.worker_id, req.currentUser.id);
    const origin = terminalOrigins.resolve(req);
    const issued = terminalNonces.issue({ sessionId: req.sessionID, userId: req.currentUser.id, sessionVersion: req.session.sessionVersion || 1, profileId: profile.id, origin });
    return res.status(201).json({ attempt_id: issued.attempt_id, expires_at: issued.expires_at, ws_url: terminalOrigins.websocketUrl(origin, issued) });
  } catch (error) {
    return res.status(error.status || 422).json({ code: error.code || 'SHELL_ATTACH_FAILED', message: error.message || 'Unable to attach shell.' });
  }
});

router.post('/account/ssh-profiles/:id/delete', async (req, res) => {
  try {
    const removed = await workerRepo.deleteProfile(req.params.id, { ownerUserId: req.currentUser.id });
    if (!removed) return res.status(404).type('html').send(errorPage(404, 'SSH Profile not found.'));
    setFlash(req, 'success', 'SSH Profile deleted. The Worker remains enrolled.');
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/ssh-profiles');
});

router.get('/account/telegram', async (req, res, next) => {
  try {
    return res.type('html').send(accountTelegramPage({
      user: req.currentUser,
      config: await userTelegramSettings.get(req.currentUser.id),
      csrfToken: csrf(req),
      ...consumeFlash(req)
    }));
  } catch (error) { next(error); }
});

router.post('/account/telegram', async (req, res) => {
  try {
    await userTelegramSettings.save(req.currentUser.id, {
      enabled: req.body.enabled === 'true',
      chatId: req.body.chat_id,
      botToken: req.body.bot_token
    });
    setFlash(req, 'success', 'Your Telegram settings were saved separately from Admin Telegram.');
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect('/account/telegram');
});

router.post('/account/telegram/test', async (req, res) => {
  try {
    const credentials = await userTelegramSettings.credentials(req.currentUser.id);
    await telegramService.sendTest(credentials.token, credentials.chatId);
    setFlash(req, 'success', 'Telegram test message delivered successfully.');
  } catch (error) { setFlash(req, 'error', `Telegram test failed: ${error.message}`); }
  return res.redirect('/account/telegram');
});

router.get('/account/profile', (req, res) => res.redirect('/account/clients'));

router.post('/account/profile', async (req, res) => {
  const returnTo = accountReturnTo(req);
  try {
    const updated = await userService.updateProfile(req.currentUser.id, { displayName: req.body.display_name, email: req.body.email });
    req.session.username = updated.username;
    setFlash(req, 'success', 'Profile updated.');
  } catch (error) { setFlash(req, 'error', error.message); }
  return res.redirect(returnTo);
});

router.post('/account/password', async (req, res, next) => {
  const returnTo = accountReturnTo(req);
  try {
    await userService.changePassword(req.currentUser.id, req.body.password);
    return req.session.destroy(error => error ? next(error) : res.redirect('/login'));
  } catch (error) {
    setFlash(req, 'error', error.message);
    return res.redirect(returnTo);
  }
});

module.exports = router;
module.exports.requireUser = requireUser;
