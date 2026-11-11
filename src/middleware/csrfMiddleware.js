const crypto = require('crypto');
const { errorPage } = require('../http/pages');

function isMachineEndpoint(req) {
  return req.path === '/mcp' || req.path.startsWith('/mcp/') ||
    req.path === '/oauth/token' || req.path === '/oauth/revoke' ||
    req.path.startsWith('/.well-known/') || req.path.startsWith('/worker/v1/');
}

function csrfProtection(req, res, next) {
  if (isMachineEndpoint(req) || !req.session) return next();
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const submitted = req.body?._csrf || req.headers['x-csrf-token'];
  if (!submitted || submitted !== req.session.csrfToken) {
    return res.status(403).type('html').send(errorPage(403, 'Invalid or missing CSRF token. Reload the page and try again.'));
  }
  return next();
}

module.exports = { csrfProtection, isMachineEndpoint };
