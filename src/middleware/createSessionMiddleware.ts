import session from 'express-session';

interface SessionMiddlewareOptions {
  store: session.Store;
  secret: string;
  secureCookie: boolean;
}

/**
 * Shared session policy used by the default self-host store and future
 * libSQL-backed Vercel Admin sessions. Never share the in-memory store
 * between distributed instances.
 */
export function createSessionMiddleware({ store, secret, secureCookie }: SessionMiddlewareOptions) {
  return session({
    store,
    secret,
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
}
