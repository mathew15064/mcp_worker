import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { canonicalRailwayOrigin } from '../src/config/railwayOrigin';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

interface Resource {
  kind: string;
  name: string;
  config: Record<string, unknown>;
}
interface RailwayProject {
  kind: string;
  name: string;
  resources: Resource[];
}

void test('offline Railway IaC graph contains only one service and one attached volume', () => {
  const source = read('.railway/railway.ts');
  const helpers = {
    defineRailway: (factory: () => RailwayProject) => factory(),
    github: (repo: string, config: Record<string, unknown>) => ({ repo, ...config }),
    preserve: () => ({ preserved: true }),
    project: (name: string, config: { resources: Resource[] }) => ({
      kind: 'project',
      name,
      ...config,
    }),
    service: (name: string, config: Record<string, unknown>) => ({
      kind: 'service',
      name,
      config,
    }),
    volume: (name: string, config: Record<string, unknown>) => ({
      kind: 'volume',
      name,
      config,
    }),
  };
  // Offline structural evaluation only: NOT a railway/iac SDK compile or CLI plan.
  const body = source
    .replace(/import \{[^}]+\} from ["']railway\/iac["'];/, '')
    .replace('export default defineRailway(', 'const result = defineRailway(');
  assert.notEqual(body, source, 'The known IaC import and declaration must match');
  const graph = vm.runInNewContext(
    'const { defineRailway, github, preserve, project, service, volume } = helpers;\n' +
      body +
      '\nresult;',
    { helpers },
    { timeout: 1000 },
  ) as RailwayProject;
  assert.equal(graph.kind, 'project');
  assert.equal(graph.resources.length, 2);
  const app = graph.resources.filter((resource) => resource.kind === 'service');
  const volumes = graph.resources.filter((resource) => resource.kind === 'volume');
  assert.equal(app.length, 1);
  assert.equal(volumes.length, 1);
  const service = app[0];
  assert.equal(service.config.replicas, 1);
  assert.equal(service.config.healthcheck, '/healthz');
  assert.equal(service.config.healthcheckTimeout, 120);
  const mounts = service.config.volumeMounts as Record<string, Resource>;
  assert.equal(Object.keys(mounts).length, 1);
  assert.equal(mounts['/app/data'], volumes[0]);
  const env = service.config.env as Record<string, string | { preserved: boolean }>;
  assert.equal(env.MCP_PLATFORM, 'railway');
  assert.equal(env.DATABASE_PATH, '/app/data/bot_report.sqlite');
  assert.equal(env.PORT, '80');
  assert.equal(env.HOST, '0.0.0.0');
  assert.equal(env.RAILWAY_RUN_UID, '0');
  assert.equal(env.RAILWAY_DOCKERFILE_PATH, 'Dockerfile.railway');
  assert.equal((env.MCP_SETUP_SECRET as { preserved: boolean }).preserved, true);
  assert.equal((service.config.source as { branch: string }).branch, 'feat/railway-p15-t02-template');
  assert.doesNotMatch(body, /\b(?:postgres|mysql|redis|mongo|upstash|neon)\s*\(/i);
});

void test('entrypoint checks mounted storage, SQLite links, node writes and privilege drop', () => {
  const script = read('docker-entrypoint-railway.sh');
  const syntax = spawnSync('sh', ['-n', path.join(root, 'docker-entrypoint-railway.sh')], {
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /\/proc\/self\/mountinfo/);
  assert.match(script, /\$5 == "\/app\/data"/);
  assert.match(script, /\.sqlite-wal/);
  assert.match(script, /\.sqlite-shm/);
  assert.match(script, /su-exec node sh -c/);
  assert.match(script, /exec su-exec node "\$@"/);
  const noVolume = spawnSync('sh', [path.join(root, 'docker-entrypoint-railway.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MCP_PLATFORM: 'railway',
      DATABASE_PATH: '/app/data/bot_report.sqlite',
      RAILWAY_VOLUME_MOUNT_PATH: '/app/data',
      RAILWAY_VOLUME_NAME: '',
    },
  });
  assert.notEqual(noVolume.status, 0);
  assert.match(noVolume.stderr, /persistent.*volume/i);
});

void test('Railway Docker runner uses isolated build and a port-aware HTTP healthcheck', () => {
  const dockerfile = read('Dockerfile.railway');
  assert.match(dockerfile, /COPY docker-entrypoint-railway\.sh \/usr\/local\/bin\//);
  assert.match(dockerfile, /apk add --no-cache su-exec/);
  assert.match(dockerfile, /USER root/);
  assert.match(dockerfile, /ENTRYPOINT \["docker-entrypoint-railway\.sh"\]/);
  assert.match(dockerfile, /CMD \["node", "dist\/src\/server\.js"\]/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/healthz/);
  assert.doesNotMatch(dockerfile, /COPY --from=builder \/app\/dist\/api/);
});

void test('canonical HTTPS origin rejects forged hosts and accepts owner custom host', () => {
  assert.equal(
    canonicalRailwayOrigin({ RAILWAY_PUBLIC_DOMAIN: 'owner.up.railway.app' }),
    'https://owner.up.railway.app',
  );
  assert.equal(
    canonicalRailwayOrigin({
      RAILWAY_PUBLIC_DOMAIN: 'owner.up.railway.app',
      MCP_PUBLIC_BASE_URL: 'https://my-worker.example.org',
    }),
    'https://my-worker.example.org',
  );
  assert.equal(canonicalRailwayOrigin({}), null);
  for (const value of [
    'attacker.example',
    'bad..up.railway.app',
    '-bad.up.railway.app',
    'bad-.up.railway.app',
    'railway.app',
    'owner.up.railway.app:1234',
    'owner.up.railway.app/evil',
  ]) {
    assert.throws(() => canonicalRailwayOrigin({ RAILWAY_PUBLIC_DOMAIN: value }), /Railway|Invalid/);
  }
  assert.throws(
    () => canonicalRailwayOrigin({ MCP_PUBLIC_BASE_URL: 'http://example.org' }),
    /Invalid/,
  );
  assert.throws(
    () => canonicalRailwayOrigin({ MCP_PUBLIC_BASE_URL: 'https://u:p@example.org' }),
    /Invalid/,
  );
});
