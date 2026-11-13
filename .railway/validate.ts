/**
 * Local-only REAL railway@3.12.0 SDK graph assertions; never calls Railway API.
 * Install once with: npm ci --prefix .railway
 * Run: .railway/node_modules/.bin/tsx .railway/validate.ts
 */
import assert from 'node:assert/strict';
import {
  RAILWAY_GRAPH_VERSION,
  createRailwayContext,
  project,
  validateGraph,
  type RailwayGraph,
} from 'railway/iac';
import railwayProgram from './railway.ts';

const definition = await railwayProgram(createRailwayContext({ command: 'plan' }), project);
const resources = (definition.resources ?? []).flat();
const services = resources.filter((resource) => resource.type === 'service');
const volumes = resources.filter((resource) => resource.type === 'volume');
assert.equal(resources.length, 2, 'no other resources');
assert.equal(services.length, 1, 'one application service');
assert.equal(volumes.length, 1, 'one persistent volume');
const app = services[0];
const data = volumes[0];
assert.equal(app.type, 'service');
assert.equal(data.type, 'volume');
if (app.type !== 'service' || data.type !== 'volume') throw Error('unexpected graph type');
assert.equal(app.deploy?.numReplicas, 1, 'one replica');
assert.equal(app.deploy?.healthcheckPath, '/healthz');
assert.equal(app.deploy?.healthcheckTimeout, 120);
assert.equal(app.deploy?.restartPolicyType, 'ON_FAILURE');
assert.equal(app.deploy?.restartPolicyMaxRetries, 10);
assert.equal(Object.keys(app.volumeAttachments ?? {}).length, 1);
assert.equal(app.volumeAttachments?.['sqlite-data']?.volume, data.address);
assert.equal(app.volumeAttachments?.['sqlite-data']?.mountPath, '/app/data');
for (const [name, value] of Object.entries({
  NODE_ENV: 'production',
  MCP_PLATFORM: 'railway',
  DATABASE_PATH: '/app/data/bot_report.sqlite',
  HOST: '0.0.0.0',
  PORT: '80',
  RAILWAY_DOCKERFILE_PATH: 'Dockerfile.railway',
  RAILWAY_RUN_UID: '0',
  RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: '0',
})) {
  assert.deepEqual(app.variables?.[name], { type: 'literal', value }, name);
}
assert.equal(app.source?.type, 'github');
assert.equal(app.source?.repo, 'mathew15064/mcp_worker');
assert.equal(app.source?.commitSha, '9a817baabdaeb6a019083252dac6ca5077257474');
assert.equal(
  app.source?.branch,
  'review/railway-p15-w3-t05-integration',
  'review source must match the original pinned PR branch, not main',
);
assert.deepEqual(app.variables?.MCP_SETUP_SECRET, { type: 'preserve' });
// No fabricated public domain: after owner approval the owner must enable
// HTTPS Public Networking on the real service, and check the generated domain.
assert.equal(Object.keys(app.networking?.serviceDomains ?? {}).length, 0);
for (const command of ['apply', 'deploy', 'template', '', 'config apply']) {
  await assert.rejects(
    () => Promise.resolve().then(() => railwayProgram(createRailwayContext({ command }), project)),
    /RAILWAY_REVIEW_ONLY/,
    command || 'missing command',
  );
}
const graph: RailwayGraph = {
  version: RAILWAY_GRAPH_VERSION,
  project: { name: definition.name },
  environments: [],
  resources,
  edges: [{ from: app.address, to: data.address, type: 'mount', key: '/app/data' }],
};
assert.deepEqual(validateGraph(graph), [], 'real SDK graph diagnostics');
console.log('RAILWAY_SDK_GRAPH_PASS: 1 service, 1 volume, 1 replica, /app/data, pinned review SHA');
console.log('RAILWAY_REVIEW_ONLY_PASS: apply/deploy/template denied; HTTPS domain NOT_TESTED');
