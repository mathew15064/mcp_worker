import test from 'node:test';
import assert from 'node:assert/strict';
import helper from './helper';
import workerRepo from '../src/repositories/workerRepository';
import terminalService from '../src/services/terminalMcpService';
import workerExec from '../src/services/workerExecutionService';
const { setupEnv, cleanup, initDb } = helper;

const env = setupEnv('terminal');
test.after(() => cleanup(env.dir));
initDb();

let adminWorker: NonNullable<Awaited<ReturnType<typeof workerRepo.createWorker>>> | null = null;

void test('terminal_list exposes Worker IDs directly and no SSH credentials', async () => {
  adminWorker = await workerRepo.createWorker({
    name: 'AdminWorker',
    publicKey: 'test-public-key',
    capabilities: ['tmux.inspect'],
  });
  if (!adminWorker) throw new Error('Fixture Worker creation failed');
  await workerRepo.createProfile({
    name: 'DevTest',
    description: 'worker-backed target',
    worker_id: adminWorker.id,
    enabled: true,
  });

  const listed = await terminalService.list();
  assert.deepEqual(listed, [
    {
      id: adminWorker.id,
      worker_id: adminWorker.id,
      name: 'AdminWorker',
      enabled: true,
      status: 'offline',
    },
  ]);
  assert.equal('host' in listed[0], false);
  assert.equal('username' in listed[0], false);
  assert.equal('password' in listed[0], false);
});

void test('Worker-backed execution profile names are unique case-insensitively', async () => {
  if (!adminWorker) throw new Error('Fixture Worker missing');
  const adminWorkerId = adminWorker.id;
  await assert.rejects(
    () =>
      workerRepo.createProfile({
        name: 'devtest',
        description: '',
        worker_id: adminWorkerId,
        enabled: true,
      }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'WORKER_PROFILE_NAME_CONFLICT',
  );
});

void test('Worker ID routes execution directly, persists after rename, and legacy aliases still resolve', async () => {
  if (!adminWorker) throw new Error('Fixture Worker missing');
  const id = adminWorker.id;
  const calls: { workerId: string; operation: string; sessionKey: unknown }[] = [];
  const fakeExec = new workerExec.WorkerExecutionService({
    broker: {
      dispatch(workerId: string, operation: string, payload: Record<string, unknown>) {
        calls.push({ workerId, operation, sessionKey: payload.session_key });
        return Promise.resolve({
          exit_code: 0, stdout: 'ok', stderr: '', duration_ms: 1,
        }) as never;
      },
    },
  });
  const service = new terminalService.TerminalMcpService({
    worker: fakeExec,
    audit: { log: () => Promise.resolve({ changes: 1, insertId: null }) },
  });
  const direct = await service.workspaceExec(id, 'printf ok');
  assert.equal(direct.stdout, 'ok');
  assert.equal(calls[0].workerId, id);
  await fakeExec.inspectProfile(await service.findProfile(id));
  assert.equal(calls[1].sessionKey, 'worker:' + id);

  await workerRepo.updateWorkerName(id, 'RenamedWorker');
  const afterRename = await service.findProfile(id);
  assert.equal(afterRename.name, 'RenamedWorker');
  assert.equal(fakeExec.shellKey(afterRename), 'worker:' + id);

  const legacy = await service.findProfile('DevTest');
  assert.equal(legacy.worker_id, id);
  assert.match(fakeExec.shellKey(legacy), /^profile:/);
  assert.notEqual(fakeExec.shellKey(legacy), 'worker:' + id);

  await assert.rejects(
    () => service.findProfile(id, { actorId: 'principal:user:foreign' }),
    { code: 'PROFILE_NOT_FOUND' },
  );
  await workerRepo.setWorkerEnabled(id, false);
  await assert.rejects(() => service.findProfile(id), { code: 'WORKER_DISABLED' });
  await workerRepo.setWorkerEnabled(id, true);
});
