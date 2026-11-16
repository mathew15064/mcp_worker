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
  assert.match(html, /mcp_worker\.read/);
  assert.match(html, /offline_access/);
});

void test('TS5 Worker dashboard has execution targets, not SSH profile forms', () => {
  const html = pages.workersPage({ workers: [], profiles: [], csrfToken: 'test' });
  assert.match(html, /New Execution Target/);
  assert.match(html, /worker-profile-modal/);
  assert.match(html, /New Execution Target · connect a Worker first/);
  assert.doesNotMatch(html, /SSH Profiles|account-ssh-modal|Attach Shell/);
});

void test('Worker Profile automatically selects its only online Worker', () => {
  const html = pages.workersPage({
    workers: [{ id: 'worker-1', name: 'Dev & Laptop', enabled: true, status: 'online' }],
    profiles: [],
    csrfToken: 'csrf',
  });
  assert.match(html, /name="worker_id" value="worker-1"/);
  assert.match(html, /Automatically using Dev &amp; Laptop/);
  assert.doesNotMatch(html, /Select online Worker/);
});

void test('Worker Profile requires a choice when multiple online Workers exist', () => {
  const html = pages.workersPage({
    workers: [
      { id: 'one', name: 'Primary', enabled: true, status: 'online' },
      { id: 'two', name: 'Secondary', enabled: true, status: 'online' },
      { id: 'disabled', name: 'Offline', enabled: true, status: 'offline' },
    ],
    profiles: [],
    csrfToken: 'csrf',
  });
  assert.match(html, /name="worker_id" required/);
  assert.match(html, /Select online Worker/);
  assert.match(html, /option value="one"/);
  assert.match(html, /option value="two"/);
  assert.doesNotMatch(html, /option value="disabled"/);
});
