import test from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import helper from './helper';
import app from '../src/app';
import { TOOLS } from '../src/mcp/toolRegistry';
const { setupEnv, cleanup, initDb, issueToken, parseMcpResponse } = helper;

const env = setupEnv('catalog-retirement');
initDb();
const retired = [
  'game_start',
  'game_restart',
  'game_status',
  'game_look',
  'game_move',
  'game_attack',
  'game_pickup',
  'game_use_item',
  'game_inventory',
  'game_unlock',
  'game_escape',
];
const expected = [
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
let server: Server;
let base: string;
let token: string;
let id = 0;
test.before(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port;
  token = (await issueToken()).token.access_token;
});
test.after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanup(env.dir);
});
async function rpc(method: string, params: Record<string, unknown>) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  assert.equal(res.status, 200);
  return parseMcpResponse(res);
}

void test('exact 15 Worker-only tools remain advertised and runtime_info agrees', async () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    expected,
  );
  const list = await rpc('tools/list', {});
  assert.deepEqual(
    list.result?.tools?.map((t) => t.name),
    expected,
  );
  const info = await rpc('tools/call', { name: 'runtime_info', arguments: {} });
  assert.equal(info.result?.structuredContent?.tool_count, 15);
  assert.equal(
    info.result?.structuredContent?.tool_schema_hash,
    'a79786ed09ba2e8eef30ec778453b17c81963bf943542c1f2ea0f87952e4a032',
  );
});

void test('all 11 retired game tools reject direct authenticated MCP calls', async () => {
  assert.equal(retired.length, 11);
  for (const name of retired) {
    const response = await rpc('tools/call', { name: name, arguments: {} });
    assert.ok(response.error || response.result?.isError, name + ' must not execute');
    const description = JSON.stringify(response.error || response.result);
    assert.match(description, /not found|unknown tool|not registered/i, name);
  }
});

void test('retired game web routes are absent', async () => {
  const page = await fetch(base + '/dungeon');
  assert.equal(page.status, 404);
  const games = await fetch(base + '/api/dungeon/games');
  assert.equal(games.status, 404);
  const health = await fetch(base + '/healthz');
  assert.equal(health.status, 200);
});
