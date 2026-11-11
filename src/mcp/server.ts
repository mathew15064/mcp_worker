import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, registerAllTools } from './toolRegistry';
import { SERVER_INSTRUCTIONS } from './instructions';

// The V2 tool catalog is fixed. Only its JSON Schema representation is shared;
// MCP servers, transports, authorization and tool handlers remain request-scoped.
let cachedStaticToolList: Promise<ListToolsResult> | null = null;
interface CreateMcpServerOptions {name?: string; version?: string; instructions?: string; toolListCache?: boolean}
interface InternalTool {enabled: boolean}

function installStaticToolListCache(server: McpServer): void {
  // SDK 1.32.2 exposes this request handler map. Fail open to the SDK's regular
  // tools/list implementation if a future SDK version changes that interface.
  const internals = server.server as unknown as {
    _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<ListToolsResult>>
  };
  const original = internals._requestHandlers?.get('tools/list');
  if (typeof original !== 'function') return;

  server.server.setRequestHandler(ListToolsRequestSchema, (request, extra) => {
    const registered = (server as unknown as {_registeredTools?: Record<string, InternalTool>})._registeredTools;
    // Preserve any per-server disabled or dynamically changed tool list.
    if (!registered || Object.keys(registered).length !== TOOLS.length ||
      TOOLS.some(tool => !registered[tool.name]?.enabled)) {
      return original(request, extra);
    }
    if (!cachedStaticToolList) {
      cachedStaticToolList = Promise.resolve().then(() => original(request, extra))
        .catch(error => {
          cachedStaticToolList = null;
          throw error;
        });
    }
    return cachedStaticToolList;
  });
}

export function createMcpServer(options: CreateMcpServerOptions = {}) {
  const server = new McpServer({
    name: options.name || 'mcp_worker',
    version: options.version || '1.0.0'
  }, {
    instructions: options.instructions || SERVER_INSTRUCTIONS
  });
  registerAllTools(server);
  if (options.toolListCache !== false && process.env.MCP_TOOL_LIST_CACHE !== 'off') {
    installStaticToolListCache(server);
  }
  return server;
}
