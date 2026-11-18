import test from 'node:test';
import assert from 'node:assert/strict';
import terminalService from '../src/services/terminalMcpService';

void test('typed execution helpers preserve validation and output normalization', () => {
  assert.deepEqual(terminalService.normalizeCapturedText('one\ntwo\n\n\n', 1), {
    text: 'two',
    lines: 1,
  });
  assert.equal(terminalService.canonicalizeWorkspaceCwd('work/a/../b'), 'work/b');
  assert.equal(terminalService.canonicalizeArtifactPath('notes/../verify.txt'), 'verify.txt');
  assert.equal(terminalService.canonicalizeRunAs('builder_1'), 'builder_1');
  assert.throws(() => terminalService.canonicalizeRunAs('builder;id'), { code: 'INVALID_RUN_AS' });
  assert.throws(() => terminalService.canonicalizeArtifactPath('report\0hidden'), {
    code: 'INVALID_ARTIFACT_PATH',
  });
});

void test('Worker discovery forwards authenticated ownership and returns immutable Worker IDs', async () => {
  const ownerValues: (string | null | undefined)[] = [];
  const id = 'c469ed74-a6ce-4d85-a6ab-5a84056fbe82';
  const service = new terminalService.TerminalMcpService({
    workers: {
      listWorkersByOwner(ownerUserId: string) {
        ownerValues.push(ownerUserId);
        return Promise.resolve([{
          id, name: 'work', enabled: true, status: 'online',
          owner_user_id: ownerUserId, hosted_isolated: true,
        }] as never);
      },
      listAdminWorkers() { return Promise.resolve([]); },
      findAdminWorkerById() { return Promise.resolve(null); },
      findWorkerByIdForOwner() { return Promise.resolve(null); },
    },
  });
  assert.deepEqual(await service.list({ actorId: 'principal:user:sample' }), [
    { id, worker_id: id, name: 'work', enabled: true, status: 'online' },
  ]);
  assert.deepEqual(ownerValues, ['sample']);
});
