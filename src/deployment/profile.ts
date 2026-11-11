/**
 * Explicit deployment selection. A profile is configuration, not a claim that
 * its storage or execution implementation is available in this release.
 */
export type DeploymentMode = 'selfhost' | 'vercel';
export type StorageDriver = 'mysql' | 'sqlite' | 'libsql';
export type ExecutionBackend = 'worker-wss' | 'sandbox' | 'durable-worker';

export interface DeploymentProfile {
  readonly id: 'selfhost-mysql' | 'selfhost-sqlite' | 'vercel-sandbox' | 'vercel-worker';
  readonly mode: DeploymentMode;
  readonly storage: StorageDriver;
  readonly execution: ExecutionBackend;
  readonly implemented: boolean;
}

export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

export class DeploymentProfileError extends Error {
  constructor(
    readonly code: 'DEPLOYMENT_CONFIGURATION_INVALID' | 'DEPLOYMENT_PROFILE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'DeploymentProfileError';
  }
}

const MODES: readonly DeploymentMode[] = ['selfhost', 'vercel'];
const DRIVERS: readonly StorageDriver[] = ['mysql', 'sqlite', 'libsql'];
const EXECUTIONS: readonly ExecutionBackend[] = ['worker-wss', 'sandbox', 'durable-worker'];

export const DEPLOYMENT_PROFILES: readonly DeploymentProfile[] = Object.freeze([
  Object.freeze({
    id: 'selfhost-mysql',
    mode: 'selfhost',
    storage: 'mysql',
    execution: 'worker-wss',
    implemented: true,
  }),
  Object.freeze({
    id: 'selfhost-sqlite',
    mode: 'selfhost',
    storage: 'sqlite',
    execution: 'worker-wss',
    implemented: false,
  }),
  Object.freeze({
    id: 'vercel-sandbox',
    mode: 'vercel',
    storage: 'libsql',
    execution: 'sandbox',
    implemented: false,
  }),
  Object.freeze({
    id: 'vercel-worker',
    mode: 'vercel',
    storage: 'libsql',
    execution: 'durable-worker',
    implemented: false,
  }),
]);

function readChoice<T extends string>(
  key: string,
  choices: readonly T[],
  fallback: T,
  environment: DeploymentEnvironment,
): T {
  const raw = environment[key];
  if (raw === undefined) return fallback;
  const selected = choices.find((choice) => choice === raw);
  if (selected !== undefined) return selected;
  throw new DeploymentProfileError(
    'DEPLOYMENT_CONFIGURATION_INVALID',
    key + ' must be one of: ' + choices.join(', ') + '.',
  );
}

export function resolveDeploymentProfile(
  environment: DeploymentEnvironment = process.env,
): DeploymentProfile {
  const mode = readChoice('DEPLOYMENT_MODE', MODES, 'selfhost', environment);
  const storage = readChoice(
    'STORAGE_DRIVER',
    DRIVERS,
    mode === 'vercel' ? 'libsql' : 'mysql',
    environment,
  );
  const execution = readChoice(
    'EXECUTION_BACKEND',
    EXECUTIONS,
    mode === 'vercel' ? 'sandbox' : 'worker-wss',
    environment,
  );
  const profile = DEPLOYMENT_PROFILES.find(
    (candidate) =>
      candidate.mode === mode && candidate.storage === storage && candidate.execution === execution,
  );
  if (!profile) {
    throw new DeploymentProfileError(
      'DEPLOYMENT_CONFIGURATION_INVALID',
      'Unsupported deployment combination: ' + [mode, storage, execution].join('/'),
    );
  }
  return profile;
}

/** Prevent deploying an advertised but unimplemented profile. */
export function requireImplementedDeploymentProfile(profile: DeploymentProfile): DeploymentProfile {
  if (!profile.implemented) {
    throw new DeploymentProfileError(
      'DEPLOYMENT_PROFILE_UNAVAILABLE',
      'Deployment profile ' + profile.id + ' is planned but not implemented.',
    );
  }
  return profile;
}
