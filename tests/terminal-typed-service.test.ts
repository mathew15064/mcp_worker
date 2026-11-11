import test from 'node:test';
import assert from 'node:assert/strict';
import terminalService from '../src/services/terminalMcpService';
import type { ExecutionProfile } from '../src/services/executionContracts';

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

void test('typed execution-profile discovery forwards the authenticated user owner', async () => {
  const ownerValues: (string | null | undefined)[] = [];
  const profile: ExecutionProfile = {
    id: 'profile-one',
    name: 'work',
    enabled: true,
    transport: 'worker',
    description: 'go Worker',
  };
  const service = new terminalService.TerminalMcpService({
    profiles: {
      async findAll({ ownerUserId = null } = {}) {
        ownerValues.push(ownerUserId);
        return [profile];
      },
      async findWithCredentialById() {
        return null;
      },
    },
  });
  assert.deepEqual(await service.list({ actorId: 'principal:user:sample' }), [
    { name: 'work', description: 'go Worker', enabled: true },
  ]);
  assert.deepEqual(ownerValues, ['sample']);
});
