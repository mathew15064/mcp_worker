/**
 * Offline Railway SDK topology and composer-checklist verification only.
 * No Railway API, CLI apply, template creation, or source registry network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RAILWAY_GRAPH_VERSION,
  createRailwayContext,
  project,
  validateGraph,
  type RailwayGraph,
} from 'railway/iac';
import railwayProgram from './railway.ts';

const UNAPPROVED_IMAGE_SENTINEL = 'OWNER_APPROVAL_REQUIRED_PREBUILT_IMAGE_DIGEST';

const definition = await railwayProgram(createRailwayContext({ command: 'plan' }), project);
const resources = (definition.resources ?? []).flat();
const services = resources.filter((resource) => resource.type === 'service');
const volumes = resources.filter((resource) => resource.type === 'volume');
assert.equal(resources.length, 2, 'no unapproved extra resources');
assert.equal(services.length, 1, 'one prebuilt image service');
assert.equal(volumes.length, 1, 'one persistent SQLite volume');
const app = services[0];
const data = volumes[0];
assert.equal(app.type, 'service');
assert.equal(data.type, 'volume');
if (app.type !== 'service' || data.type !== 'volume') throw Error('unexpected graph');
assert.equal(app.deploy?.numReplicas, 1);
assert.equal(app.deploy?.healthcheckPath, '/healthz');
assert.equal(app.deploy?.healthcheckTimeout, 120);
assert.equal(app.deploy?.restartPolicyType, 'ON_FAILURE');
assert.equal(app.deploy?.restartPolicyMaxRetries, 10);
assert.equal(Object.keys(app.volumeAttachments ?? {}).length, 1);
assert.equal(app.volumeAttachments?.['sqlite-data']?.volume, data.address);
assert.equal(app.volumeAttachments?.['sqlite-data']?.mountPath, '/app/data');
assert.equal(app.source?.type, 'image', 'GitHub source would trigger a remote build');
assert.equal(app.source?.image, UNAPPROVED_IMAGE_SENTINEL);
assert.equal(UNAPPROVED_IMAGE_SENTINEL, 'OWNER_APPROVAL_REQUIRED_PREBUILT_IMAGE_DIGEST');
assert.equal(app.source?.repo, undefined);
assert.equal(app.source?.autoUpdates, undefined);

const template = JSON.parse(
  readFileSync(new URL('./template-candidate.json', import.meta.url), 'utf8'),
);
assert.equal(template.schemaVersion, 2);
assert.equal(template.status, 'REVIEW_ONLY_NOT_PUBLISHED');
assert.equal(template.templateUrl, null);
assert.equal(template.templateCode, null);
assert.equal(template.source.provider, 'docker-image');
assert.equal(template.source.registryImage, null);
assert.equal(template.source.immutableManifestDigest, null);
assert.equal(template.source.immutableReference, null);
assert.equal(template.source.approvedSourceCommitSha, null);
assert.equal(template.source.localDockerImageId, null);
assert.equal(template.source.ownerApproved, false);
assert.equal(template.source.registryPushAuthorized, false);
assert.equal(template.source.immutablePinRequired, true);
assert.equal(template.services.length, 1);
assert.equal(template.volumes.length, 1);
assert.deepEqual(template.externalDatabases, []);
assert.equal(template.automaticCloudActions, false);
assert.equal(template.automaticGitHubActions, false);
assert.equal(template.services[0].name, app.name);
assert.equal(template.services[0].source, 'docker-image');
assert.equal(template.services[0].imageReference, null);
assert.equal(template.services[0].automaticImageUpdates, false);
assert.equal(template.services[0].replicas, app.deploy?.numReplicas);
assert.equal(template.services[0].healthcheckPath, app.deploy?.healthcheckPath);
assert.equal(template.services[0].healthcheckTimeoutSeconds, app.deploy?.healthcheckTimeout);
assert.equal(template.services[0].requiredOwnerVariables.length, 1);
assert.equal(template.services[0].requiredOwnerVariables[0].key, 'MCP_SETUP_SECRET');
assert.equal(template.services[0].requiredOwnerVariables[0].defaultValue, null);
assert.equal(template.services[0].publicNetworking.domain, null);
assert.equal(template.services[0].publicNetworking.verifyHttps, true);
assert.equal(template.volumes[0].name, data.name);
assert.equal(template.volumes[0].mountPath, '/app/data');
assert.equal(template.volumes[0].attachedService, app.name);
assert.equal(template.volumes[0].sizeMB, 512);
for (const [name, value] of Object.entries(template.services[0].variables)) {
  assert.deepEqual(app.variables?.[name], { type: 'literal', value }, name);
}
assert.equal(Object.keys(template.services[0].variables).length, 8);
assert.deepEqual(app.variables?.MCP_SETUP_SECRET, { type: 'preserve' });
assert.equal(Object.keys(app.networking?.serviceDomains ?? {}).length, 0);

const source = readFileSync(new URL('./railway.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\bgithub\s*\(/, 'no remote GitHub build source');
assert.doesNotMatch(source, /RAILWAY_DOCKERFILE_PATH/, 'no cloud Dockerfile build setting');
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
assert.deepEqual(validateGraph(graph), [], 'real railway@3.12.0 SDK graph diagnostics');
console.log('RAILWAY_SDK_GRAPH_PASS: 1 docker-image service, 1 volume, 1 replica, /app/data');
console.log(
  'RAILWAY_REVIEW_ONLY_PASS: no image/digest or public URL, GitHub build blocked, apply/deploy denied',
);
