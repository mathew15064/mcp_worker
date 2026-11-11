import test from 'node:test';
import assert from 'node:assert/strict';
import pages = require('../src/http/pages');
import ssh = require('../src/services/terminalSshService');

test('TS5 renderer escapes hostile login input without changing form contract', () => {
  const html = pages.loginPage({csrfToken: 'c<&"\'', username: '<script>alert(1)</script>', returnTo: '/admin?x="ok"'});
  assert.ok(html.includes('name="_csrf"'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('c&lt;&amp;&quot;&#39;'));
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('TS5 renderer preserves Admin and OAuth secure controls', () => {
  const html = pages.clientsPage({clients: [], csrfToken: 'test-token'});
  assert.match(html, /New Client/);
  assert.match(html, /name="_csrf"/);
  assert.match(html, /bot_report\.read/);
  assert.match(html, /offline_access/);
});

test('TS5 SSH error preserves stable machine-readable failure code', () => {
  const failure = ssh.terminalError('SSH_CONNECT_FAILED', 'connection closed');
  assert.equal(failure.code, 'SSH_CONNECT_FAILED');
  assert.equal(failure.message, 'connection closed');
  const service = new ssh.TerminalSshService();
  assert.equal(service.connectTimeoutMs, 10000);
  assert.equal(service.commandTimeoutMs, 5000);
});
