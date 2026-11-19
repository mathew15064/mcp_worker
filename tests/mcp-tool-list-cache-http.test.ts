import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import helper from './helper';
import app from '../src/app';
import oauth from '../src/repositories/mcpOAuthRepository';
import { getDb } from '../src/db/connection';
const { setupEnv, cleanup, initDb, issueToken, parseMcpResponse } = helper;

const fixture = setupEnv('mcp-tool-cache-http');
initDb();

test.after(() => cleanup(fixture.dir));

void test('cached tools/list preserves per-client OAuth revocation and separate audit records', async (t) => {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test listener missing');
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  const a = await issueToken({ principalId: 'principal:client_a' });
  const b = await issueToken({ principalId: 'principal:client_b' });
  async function list(accessToken: string, id: number) {
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
    });
  }

  if (!a.client || !b.client) throw new Error('Fixture OAuth client missing');
  const first = await list(a.token.access_token, 100);
  const second = await list(b.token.access_token, 101);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const one = await parseMcpResponse(first);
  const two = await parseMcpResponse(second);
  assert.deepEqual(one.result?.tools, two.result?.tools);
  assert.equal(one.result?.tools?.length, 15);

  for (let i = 0; i < 30; i += 1) {
    const recordsA = await oauth.listAuditLogs({ clientId: a.client.client_id, limit: 10 });
    const recordsB = await oauth.listAuditLogs({ clientId: b.client.client_id, limit: 10 });
    if (
      recordsA.some((row) => row.mcp_method === 'tools/list') &&
      recordsB.some((row) => row.mcp_method === 'tools/list')
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const recordsA = await oauth.listAuditLogs({ clientId: a.client.client_id });
  const recordsB = await oauth.listAuditLogs({ clientId: b.client.client_id });
  assert.equal(
    recordsA.filter((row) => row.mcp_method === 'tools/list' && row.result === 'SUCCESS').length,
    1,
  );
  assert.equal(
    recordsB.filter((row) => row.mcp_method === 'tools/list' && row.result === 'SUCCESS').length,
    1,
  );

  // Repeated authenticated calls must not churn SQLite writes while a token
  // remains valid. A stale last-used marker must still be refreshed promptly.
  const revokedHash = crypto.createHash('sha256').update(a.token.access_token).digest('hex');
  const db = getDb();
  const lastUsed = () =>
    (
      db
        .prepare('SELECT last_used_at FROM mcp_oauth_access_tokens WHERE token_hash = ?')
        .get(revokedHash) as { last_used_at: string | null }
    ).last_used_at;
  const firstUse = lastUsed();
  assert.ok(firstUse);
  assert.equal((await list(a.token.access_token, 104)).status, 200);
  assert.equal(lastUsed(), firstUse);
  db.prepare('UPDATE mcp_oauth_access_tokens SET last_used_at = ? WHERE token_hash = ?').run(
    new Date(Date.now() - 120_000).toISOString(),
    revokedHash,
  );
  assert.equal((await list(a.token.access_token, 105)).status, 200);
  assert.ok(Date.parse(lastUsed() || '') > Date.now() - 10_000);

  await oauth.revokeAccessToken(revokedHash);
  const revoked = await list(a.token.access_token, 102);
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers.get('www-authenticate') || '', /invalid_token/);

  const retained = await list(b.token.access_token, 103);
  assert.equal(retained.status, 200);
  const stillAllowed = await parseMcpResponse(retained);
  assert.equal(stillAllowed.result?.tools?.length, 15);
});
