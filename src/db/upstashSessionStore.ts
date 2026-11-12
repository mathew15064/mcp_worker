import session, { type SessionData } from 'express-session';
import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';

type Callback = (error?: unknown) => void;
type GetCallback = (error: unknown, data?: SessionData | null) => void;

/**
 * Persistent per-instance sessions for Vercel Functions. Never silently use
 * process memory in a multi-instance environment.
 */
export class UpstashSessionStore extends session.Store {
  private readonly redis: Redis;
  private readonly prefix: string;
  constructor() {
    super();
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN)
      throw new Error('MCP_SETUP_REQUIRES_REDIS: connect Upstash Redis in Vercel Storage.');
    const seed = process.env.MCP_SETUP_SECRET || '';
    if (seed.length < 43)
      throw new Error('MCP_SETUP_SECRET must be a random 43+ character secret.');
    this.redis = Redis.fromEnv();
    this.prefix =
      'mw:session:' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 20) + ':';
  }
  get(sid: string, cb: GetCallback) {
    void this.redis
      .get<string | SessionData>(this.prefix + sid)
      .then((data) => {
        if (!data) return cb(null, null);
        const value: unknown = typeof data === 'string' ? (JSON.parse(data) as unknown) : data;
        if (!value || typeof value !== 'object') return cb(new Error('Invalid session record.'));
        cb(null, value as SessionData);
      })
      .catch(cb);
  }
  set(sid: string, sess: SessionData, cb?: Callback) {
    const ttl = typeof sess.cookie?.maxAge === 'number' ? sess.cookie.maxAge : 86_400_000;
    void this.redis
      .set(this.prefix + sid, JSON.stringify(sess), {
        ex: Math.max(1, Math.ceil(ttl / 1000)),
      })
      .then(() => cb?.(null))
      .catch((error) => cb?.(error));
  }
  destroy(sid: string, cb?: Callback) {
    void this.redis
      .del(this.prefix + sid)
      .then(() => cb?.(null))
      .catch((error) => cb?.(error));
  }
  touch(sid: string, sess: SessionData, cb?: Callback) {
    const ttl = typeof sess.cookie?.maxAge === 'number' ? sess.cookie.maxAge : 86_400_000;
    void this.redis
      .expire(this.prefix + sid, Math.max(1, Math.ceil(ttl / 1000)))
      .then(() => cb?.(null))
      .catch((error) => cb?.(error));
  }
  close() {
    /* HTTP client has no connection to close */
  }
}
