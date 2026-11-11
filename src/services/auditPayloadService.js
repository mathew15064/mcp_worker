const REQUEST_LIMIT_BYTES = 32 * 1024;
const RESPONSE_LIMIT_BYTES = 64 * 1024;

const SENSITIVE_KEY = /(^|[_-])(authorization|cookie|set[_-]?cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)([_-]|$)/i;
const INLINE_SECRET = /\b(password|passwd|token|secret|api[_-]?key|client[_-]?secret)\s*([:=])\s*([^\s,;&]+)/gi;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function redactString(value) {
  return String(value)
    .replace(BEARER_SECRET, 'Bearer [REDACTED]')
    .replace(INLINE_SECRET, (_, key, separator) => `${key}${separator}[REDACTED]`);
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 14) return '[MAX_DEPTH]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1, seen));
  if (typeof value !== 'object') return redactString(value);
  if (seen.has(value)) return '[CIRCULAR]';

  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}

function truncateUtf8(value, limitBytes) {
  const buffer = Buffer.from(String(value), 'utf8');
  if (buffer.length <= limitBytes) return { value: buffer.toString('utf8'), truncated: false };
  return { value: buffer.subarray(0, limitBytes).toString('utf8'), truncated: true };
}

function serializePayload(value, limitBytes) {
  const sanitized = sanitize(value);
  const serialized = JSON.stringify(sanitized);
  const bounded = truncateUtf8(serialized, limitBytes);
  if (!bounded.truncated) return { payload: bounded.value, truncated: false };
  return {
    payload: JSON.stringify({
      _audit_truncated: true,
      preview: bounded.value
    }),
    truncated: true
  };
}

function parseSseBody(body) {
  const dataLines = String(body).split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  if (!dataLines.length) return null;
  const decoded = dataLines.map(line => {
    try { return JSON.parse(line); } catch (_) { return redactString(line); }
  });
  return decoded.length === 1 ? decoded[0] : decoded;
}

function normalizeResponseBody(body, contentType = '', wasTruncated = false) {
  const raw = String(body || '');
  if (!raw) return null;
  if (!wasTruncated) {
    if (String(contentType).includes('text/event-stream')) {
      const sse = parseSseBody(raw);
      if (sse !== null) return sse;
    }
    try { return JSON.parse(raw); } catch (_) {}
  }
  return { content_type: String(contentType || ''), body: redactString(raw) };
}

function createResponseCapture(res, limitBytes = RESPONSE_LIMIT_BYTES) {
  const chunks = [];
  let capturedBytes = 0;
  let truncated = false;
  const originalWrite = res.write;
  const originalEnd = res.end;

  const capture = (chunk, encoding) => {
    if (chunk === undefined || chunk === null) return;
    let buffer;
    try {
      if (Buffer.isBuffer(chunk)) buffer = chunk;
      else if (ArrayBuffer.isView(chunk)) buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      else if (chunk instanceof ArrayBuffer) buffer = Buffer.from(chunk);
      else buffer = Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    } catch (_) { return; }
    const remaining = Math.max(0, limitBytes - capturedBytes);
    if (remaining > 0) {
      const slice = buffer.subarray(0, remaining);
      chunks.push(slice);
      capturedBytes += slice.length;
    }
    if (buffer.length > remaining) truncated = true;
  };

  res.write = function patchedWrite(chunk, encoding, callback) {
    capture(chunk, encoding);
    return originalWrite.call(this, chunk, encoding, callback);
  };
  res.end = function patchedEnd(chunk, encoding, callback) {
    capture(chunk, encoding);
    return originalEnd.call(this, chunk, encoding, callback);
  };

  return {
    snapshot() {
      return { body: Buffer.concat(chunks).toString('utf8'), truncated };
    }
  };
}

function captureRequestPayload(body) {
  return serializePayload(body ?? null, REQUEST_LIMIT_BYTES);
}

function captureResponsePayload(capture, res) {
  const snapshot = capture.snapshot();
  const normalized = normalizeResponseBody(snapshot.body, res.getHeader?.('content-type') || '', snapshot.truncated);
  const serialized = serializePayload(normalized, RESPONSE_LIMIT_BYTES);
  return {
    payload: serialized.payload,
    truncated: snapshot.truncated || serialized.truncated
  };
}

module.exports = {
  REQUEST_LIMIT_BYTES,
  RESPONSE_LIMIT_BYTES,
  sanitize,
  redactString,
  serializePayload,
  normalizeResponseBody,
  createResponseCapture,
  captureRequestPayload,
  captureResponsePayload
};
