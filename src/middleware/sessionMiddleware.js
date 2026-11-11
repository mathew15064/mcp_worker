const session = require('express-session');
const config = require('../config/env');
const BoundedMemorySessionStore = require('../db/memorySessionStore');

const secureCookie = config.NODE_ENV === 'production'
  ? process.env.COOKIE_SECURE !== 'false'
  : process.env.COOKIE_SECURE === 'true';

const store = new BoundedMemorySessionStore({
  maxSessions: Number.parseInt(process.env.ADMIN_SESSION_MAX || '500', 10)
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
    maxAge: 24 * 60 * 60 * 1000
  }
});

module.exports = sessionMiddleware;
module.exports.store = store;
