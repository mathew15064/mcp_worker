declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    userId?: string;
    username?: string;
    role?: string;
    sessionVersion?: number;
    authSource?: string;
    returnTo?: string;
    flashError?: string;
    flashSuccess?: string;
    oauthOneTimeSecret?: { clientId: string; clientSecret: string } | null;
    workerEnrollment?: { token: string; expires_at?: string } | null;
  }
}
import config from '../config/env';
import BoundedMemorySessionStore from '../db/memorySessionStore';
import { createSessionMiddleware } from './createSessionMiddleware';

const secureCookie =
  config.NODE_ENV === 'production'
    ? process.env.COOKIE_SECURE !== 'false'
    : process.env.COOKIE_SECURE === 'true';

const store = new BoundedMemorySessionStore({
  maxSessions: Number.parseInt(process.env.ADMIN_SESSION_MAX || '500', 10),
});

const sessionMiddleware = createSessionMiddleware({
  store,
  secret: config.SESSION_SECRET,
  secureCookie,
});

export = Object.assign(sessionMiddleware, { store });
