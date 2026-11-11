import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitize,
  serializePayload,
  normalizeResponseBody,
  REQUEST_LIMIT_BYTES
} from '../src/services/auditPayloadService';

test('audit payload sanitizer redacts sensitive keys and common inline secrets', () => {
  const sanitized = sanitize({
    method: 'tools/call',
    params: {
      name: 'workspace_exec',
      arguments: {
        command: 'curl -H "Authorization: Bearer ' + ['abc', 'def', 'ghi'].join('.') + '" https://example.test password=hunter2',
        token: 'br_secret_value',
        nested: { client_secret: 'never-store-me', safe: 'visible' }
      }
    }
  }) as {params: {arguments: {token: string; nested: {client_secret: string; safe: string}; command: string}}};

  assert.equal(sanitized.params.arguments.token, '[REDACTED]');
  assert.equal(sanitized.params.arguments.nested.client_secret, '[REDACTED]');
  assert.equal(sanitized.params.arguments.nested.safe, 'visible');
  assert.doesNotMatch(sanitized.params.arguments.command, /abc\.def\.ghi|hunter2/);
  assert.match(sanitized.params.arguments.command, /\[REDACTED\]/);
});

test('audit payload serializer bounds oversized request data and marks it truncated', () => {
  const result = serializePayload({ value: 'x'.repeat(REQUEST_LIMIT_BYTES * 2) }, REQUEST_LIMIT_BYTES);
  assert.equal(result.truncated, true);
  const decoded = JSON.parse(result.payload);
  assert.equal(decoded._audit_truncated, true);
  assert.ok(decoded.preview.length > 1000);
});

test('audit response normalizer decodes JSON and MCP SSE data', () => {
  assert.deepEqual(normalizeResponseBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 'application/json'), {
    jsonrpc: '2.0', id: 1, result: { ok: true }
  });
  assert.deepEqual(normalizeResponseBody('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"value":3}}\n\n', 'text/event-stream'), {
    jsonrpc: '2.0', id: 2, result: { value: 3 }
  });
});
