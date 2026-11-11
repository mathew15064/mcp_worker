const crypto = require('crypto');
const { canonicalOrigin } = require('./terminalPublicOriginService');

class TerminalNonceService {
  constructor({ ttlMs = 30_000, retentionMs = 120_000, now = () => Date.now(), maxAttempts = 1024 } = {}) {
    this.ttlMs = ttlMs;
    this.retentionMs = retentionMs;
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.attempts = new Map();
    this.timer = setInterval(() => this.prune(), 10_000);
    this.timer.unref?.();
  }

  sessionHash(sessionId) {
    return crypto.createHash('sha256').update(sessionId).digest('hex');
  }

  issue({ sessionId, userId, sessionVersion, profileId, origin }) {
    this.prune();
    if (!sessionId || !userId || !profileId || !Number.isSafeInteger(sessionVersion) || sessionVersion < 1 || !canonicalOrigin(origin)) {
      throw Object.assign(new Error('Invalid terminal connection context.'), { code: 'WEBSOCKET_HANDSHAKE_FAILED' });
    }
    const records = [...this.attempts.values()];
    const pending = records.filter(record => !record.used && record.expiresAt > this.now());
    if (pending.filter(record => record.userId === userId && record.sessionHash === this.sessionHash(sessionId)).length >= 20 ||
        pending.length >= 256 || records.length >= this.maxAttempts) {
      throw Object.assign(new Error('Terminal session limit reached.'), { code: 'TERMINAL_LIMIT_REACHED' });
    }

    const nonce = crypto.randomBytes(32).toString('base64url');
    const attemptId = crypto.randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.attempts.set(attemptId, {
      attempt_id: attemptId,
      nonceHash: crypto.createHash('sha256').update(nonce).digest(),
      sessionHash: this.sessionHash(sessionId),
      userId,
      sessionVersion,
      profileId,
      origin,
      expiresAt,
      retainUntil: expiresAt + this.retentionMs,
      used: false
    });
    return { attempt_id: attemptId, nonce, expires_at: new Date(expiresAt).toISOString() };
  }

  claim(id, nonce) {
    this.prune();
    const record = typeof id === 'string' ? this.attempts.get(id) : null;
    if (!record || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return { code: 'NONCE_INVALID', record: null };
    const digest = crypto.createHash('sha256').update(nonce).digest();
    if (!crypto.timingSafeEqual(digest, record.nonceHash)) return { code: 'NONCE_INVALID', record: null };
    if (record.used) return { code: 'NONCE_REUSED', record };
    record.used = true;
    if (record.expiresAt <= this.now()) return { code: 'NONCE_EXPIRED', record };
    return { code: null, record };
  }

  matchesSession(record, sessionId) {
    return typeof sessionId === 'string' && record.sessionHash === this.sessionHash(sessionId);
  }

  prune() {
    const now = this.now();
    for (const [id, record] of this.attempts) {
      if (now >= record.retainUntil) this.attempts.delete(id);
    }
  }

  close() {
    clearInterval(this.timer);
    this.attempts.clear();
  }
}

module.exports = new TerminalNonceService();
module.exports.TerminalNonceService = TerminalNonceService;
