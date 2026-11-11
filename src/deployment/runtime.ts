import { requireImplementedDeploymentProfile, resolveDeploymentProfile } from './profile';
import type { DeploymentEnvironment, DeploymentProfile } from './profile';
import type { SessionRuntimePort, StorageRuntimePort, WorkerTransportPort } from './ports';

export interface DeploymentRuntimePorts {
  readonly storage: StorageRuntimePort;
  readonly sessions: SessionRuntimePort;
  readonly worker: WorkerTransportPort;
}

export interface DeploymentRuntime extends DeploymentRuntimePorts {
  readonly profile: DeploymentProfile;
}

/**
 * Validate the complete profile before initializing any database or opening
 * the HTTP/WS listener. These ports are deliberately injected for testing.
 */
export function createDeploymentRuntime(
  ports: DeploymentRuntimePorts,
  environment: DeploymentEnvironment = process.env,
): DeploymentRuntime {
  const profile = requireImplementedDeploymentProfile(resolveDeploymentProfile(environment));
  return Object.freeze({ profile, ...ports });
}
