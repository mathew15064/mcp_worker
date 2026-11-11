const { AsyncLocalStorage } = require('node:async_hooks');
const { AuthorizationError } = require('../auth/principal');

const mcpStorage = new AsyncLocalStorage();

function runWithPrincipal(principal, fn, options = {}) {
  return mcpStorage.run({
    principal,
    requestId: options.requestId || null,
    clientId: options.clientId || principal?.client_id || null
  }, fn);
}

function getStore() { return mcpStorage.getStore() || null; }
function getPrincipal() { return getStore()?.principal || null; }
function assertPrincipal() {
  const principal = getPrincipal();
  if (!principal) throw new AuthorizationError('No authenticated principal found in MCP request context', 401, 'UNAUTHENTICATED');
  return principal;
}

module.exports = { runWithPrincipal, getStore, getPrincipal, assertPrincipal };
