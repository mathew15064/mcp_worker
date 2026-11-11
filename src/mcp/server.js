const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TOOLS, registerAllTools } = require('./toolRegistry');
const { SERVER_INSTRUCTIONS } = require('./instructions');

// The V2 tool catalog is fixed. Only its JSON Schema representation is shared;
// MCP servers, transports, authorization and tool handlers remain request-scoped.
let cachedStaticToolList = null;

function installStaticToolListCache(server) {
  // SDK 1.32.2 exposes this request handler map. Fail open to the SDK's regular
  // tools/list implementation if a future SDK version changes that interface.
  const original = server.server?._requestHandlers?.get('tools/list');
  if (typeof original !== 'function') return;

  server.server.setRequestHandler(ListToolsRequestSchema, (request, extra) => {
    const registered = server._registeredTools;
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

function createMcpServer(options = {}) {
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

module.exports = { createMcpServer };
