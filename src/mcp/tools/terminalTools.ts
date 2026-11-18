import { z } from 'zod';
import { defineTool, type ToolResponse } from '../toolTypes';
import type { TerminalToolService } from '../terminalServiceContract';
import { assertHostedTerminalPrincipal } from '../context';
import { executionTarget, executionTargetFields } from './executionTarget';
import terminalMcpService from '../../services/terminalMcpService';
const checkedTerminalService: TerminalToolService = terminalMcpService;

function textResult(value: Record<string, unknown>): ToolResponse {
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function terminalPrincipal() {
  return assertHostedTerminalPrincipal();
}

export const listTerminals = defineTool({
  name: 'terminal_list',
  description:
    'List enrolled Workers by immutable ID for MCP execution. Use worker UUID with other tools; legacy profile aliases remain accepted. No SSH credentials.',
  schema: {},
  domain: 'Worker Execution',
  requiredScope: 'mcp_worker.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args = {}, service = checkedTerminalService) {
    void args;
    const principal = terminalPrincipal();
    return textResult({ terminals: await service.list({ actorId: principal.actor_id }) });
  },
});

export const workspaceExec = defineTool({
  name: 'workspace_exec',
  description:
    'Execute a deterministic one-shot shell command on an enrolled Worker over outbound WSS. Use as the generic fallback; prefer specialized file, Git, search and check tools.',
  schema: {
    ...executionTargetFields,
    command: z
      .string()
      .min(1)
      .max(32000)
      .describe('Shell command to execute on the enrolled Worker'),
    cwd: z
      .string()
      .max(1000)
      .optional()
      .describe(
        'Optional working directory on the enrolled Worker; absolute or relative paths are accepted',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(300000)
      .optional()
      .default(30000)
      .describe('Execution timeout in milliseconds (max 300000ms / 5 min)'),
  },
  domain: 'Worker Execution',
  requiredScope: 'mcp_worker.terminal',
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async handler(args, service = checkedTerminalService) {
    const principal = terminalPrincipal();
    const result = await service.workspaceExec(executionTarget(args), args.command, {
      cwd: args.cwd,
      timeoutMs: args.timeout_ms || 30000,
      actorId: principal.actor_id,
    });
    return textResult({ success: true, ...result });
  },
});

export const artifactCollect = defineTool({
  name: 'artifact_collect',
  description:
    'Collect a read-only verification artifact with size, MIME type, SHA-256, and text when applicable. Use after tests/UI/runtime checks for evidence; do not assume binary upload to another connector unless a real file reference is returned.',
  schema: {
    ...executionTargetFields,
    path: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        'Path to the artifact file on the enrolled Worker; absolute or relative paths are accepted',
      ),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024)
      .optional()
      .default(2 * 1024 * 1024)
      .describe('Maximum allowed artifact size in bytes (default 2 MiB, max 10 MiB)'),
  },
  domain: 'Worker Execution',
  requiredScope: 'mcp_worker.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = checkedTerminalService) {
    const principal = terminalPrincipal();
    const result = await service.artifactCollect(executionTarget(args), args.path, {
      maxBytes: args.max_bytes || 2 * 1024 * 1024,
      actorId: principal.actor_id,
    });
    return textResult({ success: true, ...result });
  },
});
