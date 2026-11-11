import crypto from 'node:crypto';
import type {Request, Response, NextFunction} from 'express';
const { errorPage }: { errorPage(status: number, message: string): string } = require('../http/pages');

export function isMachineEndpoint(req: Request) {
  return req.path === '/mcp' || req.path.startsWith('/mcp/') ||
    req.path === '/oauth/token' || req.path === '/oauth/revoke' ||
    req.path.startsWith('/.well-known/') || req.path.startsWith('/worker/v1/');
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (isMachineEndpoint(req) || !req.session) return next();
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const submitted = req.body?._csrf || req.headers['x-csrf-token'];
  if (!submitted || submitted !== req.session.csrfToken) {
    return res.status(403).type('html').send(errorPage(403, 'Invalid or missing CSRF token. Reload the page and try again.'));
  }
  return next();
}
