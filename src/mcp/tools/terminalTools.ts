import { z } from 'zod';
import { defineTool, type ToolResponse } from '../toolTypes';
import type { TerminalToolService } from '../terminalServiceContract';
import { assertPrincipal } from '../context';
import { SCOPES } from '../../auth/principal';
const terminalMcpService: TerminalToolService = require('../../services/terminalMcpService');

const profileSchema = z.string().trim().min(1).max(100).describe('Configured Terminal Profile name, for example dev2');

function textResult(value: Record<string, unknown>): ToolResponse {
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  };
}

function terminalPrincipal() {
  const principal = assertPrincipal();
  principal.assertScope(SCOPES.TERMINAL);
  return principal;
}

export const listTerminals = defineTool({
  name: 'terminal_list',
  description: 'List configured Terminal Profiles available for remote coordination. Returns aliases only; never exposes SSH credentials or hosts.',
  schema: {},
  domain: 'Terminals',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args = {}, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult({ terminals: await service.list({ actorId: principal.actor_id }) });
  }
});

export const terminalStatus = defineTool({
  name: 'terminal_status',
  description: 'Verify the SSH connection and configured tmux session for a Terminal Profile. Also reports the single target pane and its current command.',
  schema: { profile: profileSchema },
  domain: 'Terminals',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult(await service.status(args.profile, { actorId: principal.actor_id }));
  }
});

export const terminalRead = defineTool({
  name: 'terminal_read',
  description: 'Read recent sanitized text from an existing tmux session. Use for interactive coordination or secondary-agent progress; do not use as the default source-code or process-log reader when structured tools are available.',
  schema: {
    profile: profileSchema,
    lines: z.number().int().min(1).max(1000).optional().default(200).describe('Number of recent logical lines to return')
  },
  domain: 'Terminals',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult(await service.read(args.profile, args.lines || 200, { actorId: principal.actor_id }));
  }
});

export const terminalSend = defineTool({
  name: 'terminal_send',
  description: 'Send text to the single tmux pane behind a configured Terminal Profile. Use only for interactive coordination with an already-running shell or secondary agent; this is not the default coding path and does not accept raw SSH credentials.',
  schema: {
    profile: profileSchema,
    text: z.string().min(1).max(32000).describe('Text or instruction to paste into the existing tmux session'),
    submit: z.boolean().optional().default(true).describe('Press Enter after pasting the text')
  },
  domain: 'Terminals',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    const result = await service.send(args.profile, args.text, {
      submit: args.submit !== false,
      actorId: principal.actor_id
    });
    return textResult({ success: true, ...result });
  }
});


export const workspaceExec = defineTool({
  name: 'workspace_exec',
  description: 'Execute a deterministic one-shot shell command over SSH. Use as the generic fallback when no specialized structured tool fits; prefer repo_snapshot, git_diff, code_search, file_*, check_run, and process_* when they cover the task.',
  schema: {
    profile: profileSchema,
    command: z.string().min(1).max(32000).describe('Shell command to execute on the configured remote host'),
    cwd: z.string().max(1000).optional().describe('Optional working directory on the configured remote host; absolute or relative paths are accepted'),
    timeout_ms: z.number().int().min(100).max(300000).optional().default(30000).describe('Execution timeout in milliseconds (max 300000ms / 5 min)')
  },
  domain: 'Terminals',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    const result = await service.workspaceExec(args.profile, args.command, {
      cwd: args.cwd,
      timeoutMs: args.timeout_ms || 30000,
      actorId: principal.actor_id
    });
    return textResult({ success: true, ...result });
  }
});

export const terminalInterrupt = defineTool({
  name: 'terminal_interrupt',
  description: 'Send a SIGINT (Ctrl-C) to the single tmux pane behind a configured Terminal Profile to cancel or interrupt a running process.',
  schema: {
    profile: profileSchema
  },
  domain: 'Terminals',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    const result = await service.interrupt(args.profile, {
      actorId: principal.actor_id
    });
    return textResult({ success: true, ...result });
  }
});

export const artifactCollect = defineTool({
  name: 'artifact_collect',
  description: 'Collect a read-only verification artifact with size, MIME type, SHA-256, and text when applicable. Use after tests/UI/runtime checks for evidence; do not assume binary upload to another connector unless a real file reference is returned.',
  schema: {
    profile: profileSchema,
    path: z.string().min(1).max(1000).describe('Path to the artifact file on the configured remote host; absolute or relative paths are accepted'),
    max_bytes: z.number().int().min(1).max(10 * 1024 * 1024).optional().default(2 * 1024 * 1024).describe('Maximum allowed artifact size in bytes (default 2 MiB, max 10 MiB)')
  },
  domain: 'Terminals',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    const result = await service.artifactCollect(args.profile, args.path, {
      maxBytes: args.max_bytes || 2 * 1024 * 1024,
      actorId: principal.actor_id
    });
    return textResult({ success: true, ...result });
  }
});
