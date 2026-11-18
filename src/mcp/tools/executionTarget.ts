import { z } from 'zod';

// AI clients should target an enrolled Worker by immutable ID. Keep profile as a
// deprecated alias so previously configured MCP clients do not break on upgrade.
export const executionTargetFields = {
  worker: z.string().trim().uuid().optional()
    .describe('Worker ID from terminal_list (preferred execution target)'),
  profile: z.string().trim().min(1).max(100).optional()
    .describe('Deprecated: existing execution profile alias for older clients'),
};

export function executionTarget(args: { worker?: string; profile?: string }): string {
  if (args.worker && args.profile) {
    throw Object.assign(new Error('Specify either worker or legacy profile, not both.'), {
      code: 'INVALID_EXECUTION_TARGET',
    });
  }
  if (!args.worker && !args.profile) {
    throw Object.assign(new Error('A Worker ID (or legacy profile alias) is required.'), {
      code: 'INVALID_EXECUTION_TARGET',
    });
  }
  return args.worker || args.profile || '';
}
