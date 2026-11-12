import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { TOOLS } from '../src/mcp/toolRegistry';
import runtimeInfo from '../src/mcp/tools/runtimeInfo';
import { createMcpServer } from '../src/mcp/server';

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
    'a79786ed09ba2e8eef30ec778453b17c81963bf943542c1f2ea0f87952e4a032',
  );
  assert.ok(TOOLS.every((tool) => typeof tool.handler === 'function'));
});

void test('typed Zod schemas reject malformed tool input and retain defaults', () => {
  const exec = TOOLS.find((tool) => tool.name === 'workspace_exec');
  assert.ok(exec);
  const schema = z.object(exec.schema);
  assert.equal(schema.safeParse({ profile: 'dev2', command: '' }).success, false);
  assert.equal(schema.parse({ profile: 'dev2', command: 'pwd' }).timeout_ms, 30000);
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
