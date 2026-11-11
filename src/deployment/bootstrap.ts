import databaseManager from '../db/databaseManager';
import sessionMiddleware from '../middleware/sessionMiddleware';
import workerBroker from '../services/workerConnectionBroker';
import { createDeploymentRuntime } from './runtime';
import type { DeploymentEnvironment } from './profile';

/**
 * Composition root for the current self-hosted MySQL/WSS runtime.
 * Subsequent profile adapters will be selected here only after their
 * persistence, session, OAuth and worker tests pass.
 */
export function createAppRuntime(environment: DeploymentEnvironment = process.env) {
  return createDeploymentRuntime(
    {
      storage: databaseManager,
      sessions: sessionMiddleware.store,
      worker: workerBroker,
    },
    environment,
  );
}
