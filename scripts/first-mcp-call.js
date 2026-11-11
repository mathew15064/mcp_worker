#!/usr/bin/env node
// Local-only first call. Browser consent + PKCE; no credentials in argv or files.
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const CALLBACK = 'http://127.0.0.1:43871/callback';
const SCOPE = 'bot_report.read';

async function main() {
  const base = new URL(process.argv[2] || 'http://127.0.0.1:3333');
  assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) &&
    base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password,
    'Use the exact configured local HTTP loopback origin.');
  const origin = base.origin;
  const resource = origin + '/mcp';
  let clientId = process.env.BOT_REPORT_FIRST_CLIENT_ID;
  let secret = process.env.BOT_REPORT_FIRST_CLIENT_SECRET;
  if (!clientId || !secret) {
    assert.ok(process.stdin.isTTY, 'Interactive terminal required (or supply credentials through a private process environment).');
    const output = new Writable({ write(chunk, encoding, done) { if (!output.muted) process.stdout.write(chunk); done(); } });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    try {
      clientId = (await rl.question('Client ID: ')).trim();
      process.stdout.write('Client secret (hidden): ');
      output.muted = true;
      secret = (await rl.question('')).trim();
    } finally { output.muted = false; rl.close(); process.stdout.write('\n'); }
  }
  assert.ok(clientId && secret, 'Client ID and secret required.');
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorization = new URL(origin + '/oauth/authorize');
  authorization.search = new URLSearchParams({ client_id: clientId, redirect_uri: CALLBACK, response_type: 'code',
    scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', resource });
  let finish;
  const codePromise = new Promise(resolve => { finish = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, CALLBACK);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (url.pathname !== '/callback' || req.method !== 'GET' || url.searchParams.get('state') !== state) {
      res.writeHead(400).end('Invalid callback. Return to the original authorization request.'); return;
    }
    if (url.searchParams.get('error') || !url.searchParams.get('code') || url.searchParams.get('iss') !== origin) {
      res.writeHead(400).end('Authorization failed. Close this tab.'); finish(null); return;
    }
    res.end('Authorization received. Return to your terminal.'); finish(url.searchParams.get('code'));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(43871, '127.0.0.1', resolve); });
  let timer;
  let token;
  const auth = 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64');
  try {
    console.log('Open this URL in your local browser, sign in and approve Read access:\n' + authorization.href);
    const code = await Promise.race([codePromise, new Promise(resolve => { timer = setTimeout(() => resolve(null), 300000); })]);
    assert.ok(code, 'Authorization denied or timed out.');
    const response = await fetch(origin + '/oauth/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, resource, code_verifier: verifier })
    });
    assert.equal(response.status, 200, 'Token exchange failed.');
    token = (await response.json()).access_token;
    assert.ok(token, 'No access token returned.');
    const mcp = await fetch(resource, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'runtime_info', arguments: {} } })
    });
    assert.equal(mcp.status, 200, 'MCP call failed.');
    const body = await mcp.text();
    const payload = body.split('\n').find(x => x.startsWith('data: '))?.slice(6) || body;
    const result = JSON.parse(payload);
    assert.ok(!result.error && !result.result?.isError, 'runtime_info failed.');
    assert.equal(result.result.structuredContent?.tool_count, 19, 'Unexpected V2 runtime catalog.');
    console.log('PASS runtime_info — 19 tools. Refresh Getting Started / Audit Log.');
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (token) {
      try {
        const revoked = await fetch(origin + '/oauth/revoke', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, token_type_hint: 'access_token' }) });
        if (!revoked.ok) console.error('Token revocation failed; revoke the client in Admin or allow the short-lived token to expire.');
      } catch (_) { console.error('Token revocation failed; revoke the client in Admin or allow the short-lived token to expire.'); }
    }
  }
}
main().catch(error => { console.error('First MCP call failed:', error.message); process.exitCode = 1; });
