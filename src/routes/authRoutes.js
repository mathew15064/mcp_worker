const express = require('express');
const rateLimit = require('express-rate-limit');
const authService = require('../services/authService');
const adminIdentity = require('../services/adminIdentityService');
const config = require('../config/env');
const { loginPage } = require('../http/pages');

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: config.LOGIN_RATE_LIMIT_WINDOW_MS,
  max: config.LOGIN_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false
});

function currentAdmin(req) {
  return adminIdentity.currentFromSession(req.session);
}

async function currentIdentity(req) {
  return authService.currentIdentity(req.session);
}

function sanitizeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  try {
    const parsed = new URL(value, 'http://localhost');
    if (parsed.origin !== 'http://localhost') return '/';
    if (parsed.pathname === '/oauth/authorize' || parsed.pathname === '/' || parsed.pathname.startsWith('/admin') || parsed.pathname.startsWith('/account')) {
      return parsed.pathname + parsed.search;
    }
    return '/';
  } catch (_) { return '/'; }
}

function destinationFor(identity, requested = '/') {
  const safe = sanitizeReturnTo(requested);
  const defaultPath = identity?.role === 'admin' ? '/admin' : '/account/clients';
  if (safe === '/') return defaultPath;
  const pathname = new URL(safe, 'http://localhost').pathname;
  if (pathname === '/oauth/authorize') return safe;
  if (identity?.role === 'admin' && pathname.startsWith('/admin')) return safe;
  if (identity?.role === 'user' && pathname.startsWith('/account')) return safe;
  return defaultPath;
}

router.get('/login', async (req, res, next) => {
  try {
    const identity = await currentIdentity(req);
    if (identity) return res.redirect(destinationFor(identity, req.session?.returnTo || '/'));
    if (req.query.returnTo && req.session) req.session.returnTo = sanitizeReturnTo(req.query.returnTo);
    return res.type('html').send(loginPage({ csrfToken: req.session?.csrfToken || '', returnTo: req.session?.returnTo || '' }));
  } catch (error) { next(error); }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const result = await authService.authenticate(req.body?.username, req.body?.password);
    const requestedReturnTo = sanitizeReturnTo(req.body?.returnTo || req.session?.returnTo || '/');
    if (!result.success) {
      return res.status(401).type('html').send(loginPage({ csrfToken: req.session?.csrfToken || '', error: result.message, username: req.body?.username || '', returnTo: requestedReturnTo }));
    }
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.userId = result.user.id;
    req.session.username = result.user.username;
    req.session.role = result.user.role;
    req.session.sessionVersion = result.user.session_version || 1;
    req.session.authSource = result.user.auth_source || (result.user.role === 'admin' ? 'env' : 'database');
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    return res.redirect(destinationFor(result.user, requestedReturnTo));
  } catch (error) { next(error); }
});

router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

module.exports = router;
module.exports.currentAdmin = currentAdmin;
module.exports.currentIdentity = currentIdentity;
module.exports.sanitizeReturnTo = sanitizeReturnTo;
module.exports.destinationFor = destinationFor;
