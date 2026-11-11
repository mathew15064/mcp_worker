const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { setupEnv, cleanup, initDb, issueToken, parseMcpResponse } = require('./helper');

const fixture = setupEnv('mcp-tool-cache-http');
initDb();
const app = require('../src/app');
const oauth = require('../src/repositories/mcpOAuthRepository');

test.after(() => cleanup(fixture.dir));

test('cached tools/list preserves per-client OAuth revocation and separate audit records', async t => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;

  const a = await issueToken({ principalId: 'principal:client_a' });
  const b = await issueToken({ principalId: 'principal:client_b' });
  async function list(accessToken, id) {
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })
    });
  }

  const first = await list(a.token.access_token, 100);
  const second = await list(b.token.access_token, 101);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const one = await parseMcpResponse(first);
  const two = await parseMcpResponse(second);
  assert.deepEqual(one.result.tools, two.result.tools);
  assert.equal(one.result.tools.length, 19);

  for (let i = 0; i < 30; i += 1) {
    const recordsA = await oauth.listAuditLogs({ clientId: a.client.client_id, limit: 10 });
    const recordsB = await oauth.listAuditLogs({ clientId: b.client.client_id, limit: 10 });
    if (recordsA.some(row => row.mcp_method === 'tools/list') &&
        recordsB.some(row => row.mcp_method === 'tools/list')) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const recordsA = await oauth.listAuditLogs({ clientId: a.client.client_id });
  const recordsB = await oauth.listAuditLogs({ clientId: b.client.client_id });
  assert.equal(recordsA.filter(row => row.mcp_method === 'tools/list' && row.result === 'SUCCESS').length, 1);
  assert.equal(recordsB.filter(row => row.mcp_method === 'tools/list' && row.result === 'SUCCESS').length, 1);

  const revokedHash = crypto.createHash('sha256').update(a.token.access_token).digest('hex');
  await oauth.revokeAccessToken(revokedHash);
  const revoked = await list(a.token.access_token, 102);
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers.get('www-authenticate') || '', /invalid_token/);

  const retained = await list(b.token.access_token, 103);
  assert.equal(retained.status, 200);
  const stillAllowed = await parseMcpResponse(retained);
  assert.equal(stillAllowed.result.tools.length, 19);
});
