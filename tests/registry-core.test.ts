import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOLS} from '../src/mcp/toolRegistry';
import {SERVER_INSTRUCTIONS} from '../src/mcp/instructions';
const {setupEnv, cleanup, initDb} = require('./helper') as {setupEnv(name: string): {dir: string}; cleanup(dir: string): void; initDb(): void};

const env = setupEnv('registry');
test.after(() => cleanup(env.dir));
initDb();

test('MCP registry contains only coding harness primitives', () => {
  const names = TOOLS.map(tool => tool.name);
  assert.deepEqual(names, [
    'runtime_info', 'terminal_list', 'terminal_status', 'terminal_read', 'terminal_send', 'workspace_exec',
    'terminal_interrupt', 'artifact_collect', 'file_read', 'file_write', 'file_patch', 'process_start',
    'process_status', 'process_stop', 'process_logs', 'repo_snapshot', 'git_diff', 'code_search', 'check_run'
  ]);
  assert.equal(names.length, 19);
  assert.ok(!names.some(name => /(notification|inbox|control|antigravity)/i.test(name)));
});

test('tool schemas never accept raw SSH connection credentials and scopes stay minimal', () => {
  for (const tool of TOOLS) {
    assert.equal((tool.schema as Record<string, unknown>)?.host, undefined, `${tool.name} must not accept host`);
    assert.equal((tool.schema as Record<string, unknown>)?.username, undefined, `${tool.name} must not accept username`);
    assert.equal((tool.schema as Record<string, unknown>)?.password, undefined, `${tool.name} must not accept password`);
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs usage guidance`);
    if (tool.name === 'runtime_info') assert.equal(tool.requiredScope, 'bot_report.read');
    else assert.equal(tool.requiredScope, 'bot_report.terminal');
  }
});

test('server instructions describe MCP-only workflow', () => {
  assert.match(SERVER_INSTRUCTIONS, /MCP-only/);
  assert.match(SERVER_INSTRUCTIONS, /workspace_exec only as the generic fallback/);
  assert.match(SERVER_INSTRUCTIONS, /file_read\.sha256 as expected_sha256/);
});
