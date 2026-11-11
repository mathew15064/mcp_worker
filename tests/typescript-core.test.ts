import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticatedPrincipal, AuthorizationError, SCOPES } from '../src/auth/principal';
import { assertPrincipal, getStore, runWithPrincipal } from '../src/mcp/context';

test('typed principal preserves scope and identity semantics', () => {
  const p = new AuthenticatedPrincipal({ principalId: 'principal:test', scopes: SCOPES.READ });
  assert.equal(p.id, 'principal:test');
  assert.equal(p.hasScope(SCOPES.READ), true);
  assert.throws(() => p.assertScope(SCOPES.TERMINAL), (e: unknown) =>
    e instanceof AuthorizationError && e.status === 403 && e.code === 'INSUFFICIENT_SCOPE');
});

test('typed request contexts isolate concurrent principals across await', async () => {
  const left = new AuthenticatedPrincipal({ principalId: 'left', clientId: 'client-left' });
  const right = new AuthenticatedPrincipal({ principalId: 'right', clientId: 'client-right' });
  assert.throws(assertPrincipal, AuthorizationError);
  await Promise.all([left, right].map(p => runWithPrincipal(p, async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(assertPrincipal(), p);
    assert.equal(getStore()?.clientId, p.client_id);
  })));
  assert.equal(getStore(), null);
});
