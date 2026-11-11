import test from 'node:test';
import assert from 'node:assert/strict';
import {createMcpServer} from '../src/mcp/server';
import type {ListToolsResult} from '@modelcontextprotocol/sdk/types.js';

function listTools(server: ReturnType<typeof createMcpServer>): Promise<ListToolsResult> {
  const internal = server.server as unknown as {_requestHandlers: Map<string,(request: unknown, extra: unknown) => Promise<ListToolsResult>>};
  const handler = internal._requestHandlers.get('tools/list');
  assert.equal(typeof handler, 'function');
  if (!handler) throw new Error('MCP list handler missing');
  return handler({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }, {});
}

test('static tools/list cache returns the exact SDK schemas across distinct V2 MCP servers', async () => {
  const sdkBaseline = createMcpServer({ toolListCache: false });
  const cachedA = createMcpServer();
  const cachedB = createMcpServer();
  const expected = await listTools(sdkBaseline);
  const first = await listTools(cachedA);
  const second = await listTools(cachedB);
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.equal(first.tools.length, 19);
  assert.equal(first, second, 'cached tool list should reuse the same static schema object');
  assert.notEqual(cachedA, cachedB, 'each request must still get its own MCP server');
});

test('cache respects per-server disabled tools and can be disabled entirely', async () => {
  const standard = createMcpServer();
  const cached = await listTools(standard);
  const modified = createMcpServer();
  const registered = modified as unknown as {_registeredTools: Record<string,{enabled: boolean}>};
  registered._registeredTools.runtime_info.enabled = false;
  const list = await listTools(modified);
  assert.equal(list.tools.length, 18);
  assert.ok(!list.tools.some(tool => tool.name === 'runtime_info'));
  assert.equal(cached.tools.length, 19);

  const noCacheA = createMcpServer({ toolListCache: false });
  const noCacheB = createMcpServer({ toolListCache: false });
  const a = await listTools(noCacheA);
  const b = await listTools(noCacheB);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'kill switch should use SDK generated response per request');
});
