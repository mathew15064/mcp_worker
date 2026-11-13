/**
 * Offline REAL Railway SDK graph validation. No Railway credentials, CLI plan,
 * remote projects, resource creation or network API calls.
 * Run after npm ci --prefix .railway: .railway/node_modules/.bin/tsx .railway/validate.ts
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
assert.equal(services.length, 1, 'exactly one Node service');
assert.equal(volumes.length, 1, 'exactly one SQLite volume');
const app = services[0];
const data = volumes[0];
assert.equal(app.type, 'service');
assert.equal(data.type, 'volume');
if (app.type !== 'service' || data.type !== 'volume') throw Error('unexpected graph type');
assert.equal(app.deploy?.numReplicas, 1, 'exactly one replica');
assert.equal(app.deploy?.healthcheckPath, '/healthz');
assert.equal(Object.keys(app.volumeAttachments ?? {}).length, 1);
assert.equal(app.volumeAttachments?.['sqlite-data']?.volume, data.address);
assert.equal(app.volumeAttachments?.['sqlite-data']?.mountPath, '/app/data');
assert.deepEqual(app.variables?.DATABASE_PATH, {
  type: 'literal',
  value: '/app/data/bot_report.sqlite',
});
assert.equal(app.source?.commitSha, 'e7de57a28f4894d302a6dfb24a577ea7b38b9a08');
assert.equal(app.source?.repo, 'mathew15064/mcp_worker');
assert.equal(app.source?.type, 'github');
const graph: RailwayGraph = {
  version: RAILWAY_GRAPH_VERSION,
  project: { name: definition.name },
  environments: [],
  resources,
  edges: [{ from: app.address, to: data.address, type: 'mount', key: '/app/data' }],
};
const diagnostics = validateGraph(graph);
assert.deepEqual(diagnostics, [], 'real SDK graph validation diagnostics');
console.log(
  'RAILWAY_SDK_GRAPH_PASS: 1 github service, 1 volume, 1 replica, /app/data; CLI_PLAN_BLOCKED (unlinked)',
);
