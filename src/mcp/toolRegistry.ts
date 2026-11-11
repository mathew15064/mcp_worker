import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResponse } from './toolTypes';
import type { z } from 'zod';
import runtimeInfo = require('./tools/runtimeInfo');
import {
  listTerminals, terminalStatus, terminalRead, terminalSend,
  workspaceExec, terminalInterrupt, artifactCollect
} from './tools/terminalTools';
import {
  fileRead, fileWrite, filePatch, processStart, processStatus,
  processStop, processLogs, repoSnapshot, gitDiff, codeSearch, checkRun
} from './tools/localCodingTools';

// Preserve the original static wire schema and catalog order.
Object.assign(runtimeInfo, {domain: 'System', requiredScope: 'bot_report.read'});

export const TOOLS = [
  runtimeInfo, listTerminals, terminalStatus, terminalRead, terminalSend,
  workspaceExec, terminalInterrupt, artifactCollect,
  fileRead, fileWrite, filePatch, processStart, processStatus,
  processStop, processLogs, repoSnapshot, gitDiff, codeSearch, checkRun
] as const;

export function registerAllTools(mcpServer: McpServer): void {
  for (const definition of TOOLS) {
    const tool: {name: string; description: string; schema: z.ZodRawShape; annotations?: {readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean}; handler(args: never): Promise<ToolResponse>} = definition;
    const invoke = async (args: Record<string, unknown>): Promise<ToolResponse> => tool.handler(args as never);
    // Each definition is checked against its own Zod shape at declaration.
    // At this SDK boundary, the SDK validates the input before invoking the
    // handler; the union of 19 independently typed handlers needs one cast.
    if (tool.annotations) {
      mcpServer.tool(tool.name, tool.description, tool.schema, tool.annotations,
        invoke);
    } else {
      mcpServer.tool(tool.name, tool.description, tool.schema,
        invoke);
    }
  }
}
