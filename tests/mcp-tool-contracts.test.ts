import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { TOOLS } from '../src/mcp/toolRegistry';
import runtimeInfo from '../src/mcp/tools/runtimeInfo';
import { createMcpServer } from '../src/mcp/server';
import { executionTarget } from '../src/mcp/tools/executionTarget';

const names = [
  'runtime_info',
  'terminal_list',
  'workspace_exec',
  'artifact_collect',
  'file_read',
  'file_write',
  'file_patch',
  'process_start',
  'process_status',
  'process_stop',
  'process_logs',
  'repo_snapshot',
  'git_diff',
  'code_search',
  'check_run',
];

void test('TS3 catalog preserves all 15 Worker-only tool schemas and order', () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    names,
  );
  assert.equal(
    runtimeInfo._test.schemaFingerprint(TOOLS),
    'aedace47f553524f528b8f9e0330e911e37003308fe5c7dcb674c563009b86c1',
  );
  assert.ok(TOOLS.every((tool) => typeof tool.handler === 'function'));
});

void test('typed Zod schemas reject malformed tool input and retain defaults', () => {
  const exec = TOOLS.find((tool) => tool.name === 'workspace_exec');
  assert.ok(exec);
  const schema = z.object(exec.schema);
  assert.equal(schema.safeParse({ profile: 'dev2', command: '' }).success, false);
  assert.equal(schema.parse({ profile: 'dev2', command: 'pwd' }).timeout_ms, 30000);
  const workerId = '97d0d9dc-7bcd-4fa0-96ce-aa10c3ee97d0';
  assert.equal(schema.parse({ worker: workerId, command: 'pwd' }).worker, workerId);
  assert.equal(schema.safeParse({ worker: 'other-client-name', command: 'pwd' }).success, false);
  assert.equal(executionTarget({ worker: workerId }), workerId);
  assert.equal(executionTarget({ profile: 'dev2' }), 'dev2');
  assert.throws(() => executionTarget({}), { code: 'INVALID_EXECUTION_TARGET' });
  assert.throws(() => executionTarget({ worker: workerId, profile: 'dev2' }), {
    code: 'INVALID_EXECUTION_TARGET',
  });
  assert.equal(
    schema.safeParse({ profile: 'dev2', command: 'pwd', timeout_ms: 300001 }).success,
    false,
  );
});

void test('each MCP server uses independent registration state', () => {
  const first = createMcpServer();
  const second = createMcpServer();
  assert.notEqual(first, second);
  assert.notEqual(first.server, second.server);
});
