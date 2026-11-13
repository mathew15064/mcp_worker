import session from 'express-session';
declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    userId?: string;
    username?: string;
    role?: string;
    sessionVersion?: number;
    authSource?: string;
    adminCredentialFingerprint?: string;
    returnTo?: string;
    flashError?: string;
    flashSuccess?: string;
    oauthOneTimeSecret?: { clientId: string; clientSecret: string } | null;
    workerEnrollment?: { token: string; expires_at?: string } | null;
  }
}
import config from '../config/env';
import BoundedMemorySessionStore from '../db/memorySessionStore';
import SqliteSessionStore from '../db/sessionStore';

const secureCookie =
  process.env.MCP_PLATFORM === 'railway' ||
  (config.NODE_ENV === 'production'
    ? process.env.COOKIE_SECURE !== 'false'
    : process.env.COOKIE_SECURE === 'true');

const store =
  process.env.MCP_PLATFORM === 'railway'
    ? new SqliteSessionStore()
    : new BoundedMemorySessionStore({
        maxSessions: Number.parseInt(process.env.ADMIN_SESSION_MAX || '500', 10),
      });

const sessionMiddleware = session({
  store,
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'bot_report.sid',
  cookie: {
    httpOnly: true,
    secure: secureCookie,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
});

export = Object.assign(sessionMiddleware, { store });
