import test from 'node:test';
import assert from 'node:assert/strict';
import helper = require('./helper');
import legacyRepo = require('../src/repositories/terminalProfileRepository');
import credentials = require('../src/services/terminalCredentialService');
import workerRepo = require('../src/repositories/workerRepository');
import terminalService = require('../src/services/terminalMcpService');
const {setupEnv, cleanup, initDb} = helper;

const env = setupEnv('terminal');
test.after(() => cleanup(env.dir));
initDb();

let adminWorker: NonNullable<Awaited<ReturnType<typeof workerRepo.createWorker>>> | null = null;

test('terminal_list exposes only global Worker-backed aliases and never legacy SSH credentials', async () => {
  const envelope = credentials.encrypt('fixture-password');
  assert.doesNotMatch(envelope, /fixture-password/);
  await legacyRepo.create({
    name: 'LegacyDirectSsh', description: 'legacy host', host: '127.0.0.1', port: 22,
    username: 'dev', tmux_session: 'main', enabled: true
  }, envelope);

  adminWorker = await workerRepo.createWorker({
    name: 'AdminWorker', publicKey: 'test-public-key', capabilities: ['tmux.inspect']
  });
  if (!adminWorker) throw new Error('Fixture Worker creation failed');
  await workerRepo.createProfile({
    name: 'DevTest', description: 'worker-backed target', worker_id: adminWorker!.id, enabled: true
  });

  const listed = await terminalService.list();
  assert.deepEqual(listed, [{ name: 'DevTest', description: 'worker-backed target', enabled: true }]);
  assert.equal('host' in listed[0], false);
  assert.equal('username' in listed[0], false);
  assert.equal('password' in listed[0], false);
  assert.equal(listed.some(item => item.name === 'LegacyDirectSsh'), false);
});

test('Worker-backed execution profile names are unique case-insensitively', async () => {
  if (!adminWorker) throw new Error('Fixture Worker missing');
  await assert.rejects(() => workerRepo.createProfile({
    name: 'devtest', description: '', worker_id: adminWorker!.id, enabled: true
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'WORKER_PROFILE_NAME_CONFLICT');
});
