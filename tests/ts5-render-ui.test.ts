import test from 'node:test';
import assert from 'node:assert/strict';
import pages from '../src/http/pages';

void test('TS5 renderer escapes hostile login input without changing form contract', () => {
  const html = pages.loginPage({
    csrfToken: 'c<&"\'',
    username: '<script>alert(1)</script>',
    returnTo: '/admin?x="ok"',
  });
  assert.ok(html.includes('name="_csrf"'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('c&lt;&amp;&quot;&#39;'));
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

void test('TS5 renderer preserves Admin and OAuth secure controls', () => {
  const html = pages.clientsPage({ clients: [], csrfToken: 'test-token' });
  assert.match(html, /New Client/);
  assert.match(html, /name="_csrf"/);
  assert.match(html, /bot_report\.read/);
  assert.match(html, /offline_access/);
});

void test('TS5 Worker dashboard has execution targets, not SSH profile forms', () => {
  const html = pages.workersPage({ workers: [], profiles: [], csrfToken: 'test' });
  assert.match(html, /New Execution Target/);
  assert.match(html, /worker-profile-modal/);
  assert.doesNotMatch(html, /SSH Profiles|account-ssh-modal|Attach Shell/);
});
