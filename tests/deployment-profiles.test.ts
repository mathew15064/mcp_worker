import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  DEPLOYMENT_PROFILES,
  DeploymentProfileError,
  requireImplementedDeploymentProfile,
  resolveDeploymentProfile,
} from '../src/deployment/profile';
import { createDeploymentRuntime } from '../src/deployment/runtime';
import type { DeploymentRuntimePorts } from '../src/deployment/runtime';

const expectedIds = ['selfhost-mysql', 'selfhost-sqlite', 'vercel-sandbox', 'vercel-worker'];

void test('deployment manifest exposes the two modes without enabling unfinished backends', () => {
  assert.deepEqual(
    DEPLOYMENT_PROFILES.map((profile) => profile.id),
    expectedIds,
  );
  assert.deepEqual(
    DEPLOYMENT_PROFILES.filter((profile) => profile.implemented).map((profile) => profile.id),
    ['selfhost-mysql'],
  );
});

void test('legacy self-host installs keep the MySQL/WSS default profile', () => {
  const profile = resolveDeploymentProfile({});
  assert.deepEqual(
    [profile.id, profile.mode, profile.storage, profile.execution],
    ['selfhost-mysql', 'selfhost', 'mysql', 'worker-wss'],
  );
  assert.equal(requireImplementedDeploymentProfile(profile), profile);
  assert.equal(
    resolveDeploymentProfile({
      DEPLOYMENT_MODE: 'selfhost',
      STORAGE_DRIVER: 'mysql',
      EXECUTION_BACKEND: 'worker-wss',
    }),
    profile,
  );
});

void test('planned SQLite and Vercel profiles are parseable but fail closed at runtime', () => {
  const configs = [
    { DEPLOYMENT_MODE: 'selfhost', STORAGE_DRIVER: 'sqlite' },
    { DEPLOYMENT_MODE: 'vercel' },
    { DEPLOYMENT_MODE: 'vercel', EXECUTION_BACKEND: 'durable-worker' },
  ];
  for (const config of configs) {
    const profile = resolveDeploymentProfile(config);
    assert.equal(profile.implemented, false);
    assert.throws(
      () => requireImplementedDeploymentProfile(profile),
      (error: unknown) =>
        error instanceof DeploymentProfileError && error.code === 'DEPLOYMENT_PROFILE_UNAVAILABLE',
    );
  }
});

void test('unknown modes, engines and mismatched combinations are rejected', () => {
  const configs = [
    { DEPLOYMENT_MODE: '' },
    { DEPLOYMENT_MODE: 'serverless' },
    { STORAGE_DRIVER: 'postgres' },
    { EXECUTION_BACKEND: 'ssh' },
    { DEPLOYMENT_MODE: 'vercel', STORAGE_DRIVER: 'mysql' },
    { DEPLOYMENT_MODE: 'selfhost', EXECUTION_BACKEND: 'sandbox' },
  ];
  for (const config of configs) {
    assert.throws(
      () => resolveDeploymentProfile(config),
      (error: unknown) =>
        error instanceof DeploymentProfileError &&
        error.code === 'DEPLOYMENT_CONFIGURATION_INVALID',
    );
  }
});

void test('unfinished cloud profile is refused by the real server before HTTP listen', () => {
  const entrypoint = path.resolve(__dirname, '../src/server.js');
  const result = spawnSync(process.execPath, [entrypoint], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SESSION_SECRET: 'deployment-profile-test-secret-is-not-real-0123456789',
      DEPLOYMENT_MODE: 'vercel',
      STORAGE_DRIVER: 'libsql',
      EXECUTION_BACKEND: 'sandbox',
    },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEPLOYMENT_PROFILE_UNAVAILABLE/);
  assert.doesNotMatch(result.stdout, /mcp_worker listening/);
});

void test('runtime composition returns existing ports and does not start services', () => {
  const calls: string[] = [];
  const ports: DeploymentRuntimePorts = {
    storage: {
      initialize() {
        calls.push('storage-init');
        return Promise.resolve({ state: 'READY' });
      },
      isOperational: () => true,
      isMysqlReady: () => true,
      getAdapter: () => null,
      close() {
        calls.push('storage-close');
        return Promise.resolve();
      },
    },
    sessions: {
      close: () => calls.push('session-close'),
    },
    worker: {
      attach: () => calls.push('worker-attach'),
      close: () => calls.push('worker-close'),
      async dispatch<T>() {
        return Promise.reject<T>(new Error('Fake worker is not connected'));
      },
    },
  };
  const runtime = createDeploymentRuntime(ports, {});
  assert.equal(runtime.profile.id, 'selfhost-mysql');
  assert.equal(runtime.storage, ports.storage);
  assert.equal(runtime.sessions, ports.sessions);
  assert.equal(runtime.worker, ports.worker);
  assert.deepEqual(calls, []);
  assert.throws(
    () => createDeploymentRuntime(ports, { DEPLOYMENT_MODE: 'vercel' }),
    (error: unknown) =>
      error instanceof DeploymentProfileError && error.code === 'DEPLOYMENT_PROFILE_UNAVAILABLE',
  );
  assert.deepEqual(calls, []);
});
