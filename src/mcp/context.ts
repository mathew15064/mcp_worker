import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthenticatedPrincipal } from '../auth/principal';
import { AuthorizationError, SCOPES } from '../auth/principal';
import runtimeSettings from '../services/runtimeSettingsService';
export interface McpRequestContext {
  principal: AuthenticatedPrincipal | null;
  requestId: string | null;
  clientId: string | null;
}
interface ContextOptions {
  requestId?: string | null;
  clientId?: string | null;
}
const mcpStorage = new AsyncLocalStorage<McpRequestContext>();
export function runWithPrincipal<T>(
  principal: AuthenticatedPrincipal | null,
  fn: () => T,
  options: ContextOptions = {},
): T {
  return mcpStorage.run(
    {
      principal,
      requestId: options.requestId || null,
      clientId: options.clientId || principal?.client_id || null,
    },
    fn,
  );
}
export function getStore(): McpRequestContext | null {
  return mcpStorage.getStore() || null;
}
export function getPrincipal(): AuthenticatedPrincipal | null {
  return getStore()?.principal || null;
}
export function assertHostedTerminalPrincipal(): AuthenticatedPrincipal {
  const principal = assertPrincipal();
  principal.assertScope(SCOPES.TERMINAL);
  if (principal.owner_user_id && !runtimeSettings.bool('hosted.execution.enabled', false)) {
    throw new AuthorizationError('Hosted execution is disabled until isolated per-user runtimes are verified.', 403, 'HOSTED_EXECUTION_DISABLED');
  }
  return principal;
}

export function assertPrincipal(): AuthenticatedPrincipal {
  const principal = getPrincipal();
  if (!principal)
    throw new AuthorizationError(
      'No authenticated principal found in MCP request context',
      401,
      'UNAUTHENTICATED',
    );
  return principal;
}
