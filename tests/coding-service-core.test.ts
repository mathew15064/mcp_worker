import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import terminalMcp from '../src/services/terminalMcpService';
const { TerminalMcpService, canonicalizeRunAs, canonicalizeWorkspaceCwd } = terminalMcp;

function serviceWithArtifact(text: string) {
  let content = text;
  const artifact = () => ({
    real_path: '/tmp/a.txt',
    size: Buffer.byteLength(content),
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    is_text: true,
    text: content,
  });
  const profile = {
    id: 'p1',
    name: 'Dev',
    enabled: true,
    transport: 'worker',
    worker_id: 'w1',
  };
  return {
    service: new TerminalMcpService({
      profiles: { findAll: () => [profile] },
      audit: { log: () => {} },
      worker: {
        collectArtifact: async () => artifact(),
        writeTextFile: async (
          _profile: unknown,
          _password: unknown,
          _path: unknown,
          next: string,
        ) => {
          content = next;
        },
      },
    } as unknown as ConstructorParameters<typeof TerminalMcpService>[0]),
    artifact,
  };
}

void test('file_patch fails closed on stale SHA and does not write', async () => {
  const { service, artifact } = serviceWithArtifact('hello world');
  await assert.rejects(
    () =>
      service.filePatch('Dev', '/tmp/a.txt', 'world', 'MCP', { expectedSha256: '0'.repeat(64) }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FILE_CHANGED',
  );
  assert.equal(artifact().text, 'hello world');
});

void test('file_patch applies deterministic exact replacement with matching SHA', async () => {
  const { service, artifact } = serviceWithArtifact('hello world');
  const result = await service.filePatch('Dev', '/tmp/a.txt', 'world', 'MCP', {
    expectedSha256: artifact().sha256,
  });
  assert.equal(result.replacements, 1);
  assert.equal(artifact().text, 'hello MCP');
});

void test('run_as and cwd validators reject control characters', () => {
  assert.equal(canonicalizeRunAs('dev_2'), 'dev_2');
  assert.throws(
    () => canonicalizeRunAs('dev\n2'),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'INVALID_RUN_AS',
  );
  assert.throws(
    () => canonicalizeWorkspaceCwd('/tmp/x\nnext'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_CWD',
  );
});
