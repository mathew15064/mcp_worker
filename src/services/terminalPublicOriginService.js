function originError() {
  return Object.assign(new Error('Terminal browser origin could not be verified.'), { code: 'WEBSOCKET_ORIGIN_REJECTED' });
}

function canonicalOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) return null;
    return url.origin;
  } catch (_) {
    return null;
  }
}

function resolve(req) {
  const browserOrigin = canonicalOrigin(req.headers?.origin);
  if (!browserOrigin) throw originError();
  const host = req.get?.('host') || req.headers?.host;
  if (typeof host !== 'string' || /[\s/@?#\\]/.test(host)) throw originError();
  const expected = canonicalOrigin(`${req.protocol}://${host}`);
  if (!expected || expected !== browserOrigin) throw originError();
  return browserOrigin;
}

function websocketUrl(origin, attempt) {
  const url = new URL('/terminal/ws', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('attempt_id', attempt.attempt_id);
  url.searchParams.set('nonce', attempt.nonce);
  return url.href;
}

module.exports = { resolve, canonicalOrigin, websocketUrl };
