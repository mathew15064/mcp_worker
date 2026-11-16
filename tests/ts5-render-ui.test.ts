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

void test('Admin Worker page always offers first-time Worker installation', () => {
  const html = pages.workersPage({ workers: [], profiles: [], csrfToken: 'test' });
  assert.match(html, /Install \/ Connect Worker/);
  assert.match(html, /action="\/admin\/workers\/enrollment"/);
  assert.match(html, /Start with Install \/ Connect Worker above/);
  assert.match(html, /data-modal-open="worker-enrollment-modal"/);
  assert.match(html, /Generate one-time token/);
  assert.match(html, /Signed one-command installation unavailable/);
  assert.match(html, /<details[^>]*><summary>Developer fallback/);
  assert.match(html, /go build -trimpath -o worker_mcp/);
  assert.doesNotMatch(html, /id="worker-install-(linux|macos|windows)-command"/);
  assert.doesNotMatch(html, /id="worker-enrollment-token"/);
  assert.doesNotMatch(html, /data-auto-open="true"/);
  assert.doesNotMatch(html, /New Execution Target · connect a Worker first/);
  assert.doesNotMatch(html, /SSH Profiles|account-ssh-modal|Attach Shell/);
});

void test('Admin Worker setup shows a real one-time token and manual build path while signed binary distribution stays blocked', () => {
  const html = pages.workersPage({
    workers: [],
    profiles: [],
    csrfToken: 'test',
    enrollment: { token: 'br_enroll_test_fixture_only', expires_at: '2026-11-16T18:00:00Z' },
    workerInstallUrl: 'https://mcp.example.test/worker/install.sh',
  });
  assert.match(html, /Install & Connect Worker/);
  assert.match(html, /br_enroll_test_fixture_only/);
  assert.match(html, /Owner approval of a signed Worker release is pending/);
  assert.match(html, /data-auto-open="true"/);
  assert.doesNotMatch(html, /Generate one-time token<\/button>/);
  assert.match(html, /go build -trimpath -o worker_mcp/);
  assert.match(html, /worker_mcp login --server https:\/\/mcp\.example\.test/);
  assert.match(html, /Profile is created automatically/);
  assert.doesNotMatch(html, /id="worker-install-linux-command"/);
});

void test('HTTP-only Worker setup stays fail-closed and never advertises an install command', () => {
  const html = pages.workersPage({
    workers: [],
    profiles: [],
    csrfToken: 'test',
    workerInstallUrl: 'http://mcp.example.test/worker/install.sh',
    enrollment: { token: 'br_enroll_http_fixture', expires_at: '2026-11-16T18:00:00Z' },
  });
  assert.match(html, /Public installers return HTTP 503/);
  assert.doesNotMatch(html, /id="worker-install-(linux|macos|windows)-command"/);
  assert.match(html, /HTTPS required for remote Worker connections/);
  assert.match(html, /https:\/\/YOUR_MCP_DOMAIN/);
});

void test('User Worker page cannot bypass signed-release enrollment gating', () => {
  const html = pages.workersPage({
    workers: [],
    profiles: [],
    csrfToken: 'test',
    accountUser: { id: 'user-1' },
  });
  assert.doesNotMatch(html, /action="\/account\/workers\/enrollment"/);
  assert.match(html, /Signed Worker release approval pending/);
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
