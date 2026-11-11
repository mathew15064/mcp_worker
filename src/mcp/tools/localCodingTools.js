const { z } = require('zod');
const { assertPrincipal } = require('../context');
const { SCOPES } = require('../../auth/principal');
const terminalMcpService = require('../../services/terminalMcpService');

const profileSchema = z.string().trim().min(1).max(100).describe('Configured Terminal Profile name');
const pathSchema = z.string().min(1).max(2000).describe('Path on the configured remote host');
const processIdSchema = z.string().regex(/^brproc-[a-f0-9]{16}$/).describe('Managed process identifier returned by process_start');

function textResult(value) {
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

const fileRead = {
  name: 'file_read',
  description: 'Read UTF-8 text with SHA-256 metadata, optionally by line range. Use after code_search or when a file is known, and before editing existing files; prefer bounded ranges over broad reads.',
  schema: {
    profile: profileSchema,
    path: pathSchema,
    run_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/).optional().describe('Optional local user to execute as via sudo -n -u'),
    max_bytes: z.number().int().min(1).max(2 * 1024 * 1024).optional().default(512 * 1024),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional()
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult(await service.fileRead(args.profile, args.path, {
      maxBytes: args.max_bytes || 512 * 1024,
      startLine: args.start_line ?? null,
      endLine: args.end_line ?? null,
      runAs: args.run_as || null,
      actorId: principal.actor_id
    }));
  }
};

const fileWrite = {
  name: 'file_write',
  description: 'Atomically create or fully replace a UTF-8 text file. Use for new files or intentional full-file replacement; prefer file_patch for localized edits. Use expected_sha256 when replacing an existing file from a prior read.',
  schema: {
    profile: profileSchema,
    path: pathSchema,
    run_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/).optional().describe('Optional local user to execute as via sudo -n -u'),
    content: z.string().max(2 * 1024 * 1024),
    create_dirs: z.boolean().optional().default(false),
    expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional()
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult({ success: true, ...(await service.fileWrite(args.profile, args.path, args.content, {
      createDirs: args.create_dirs === true,
      expectedSha256: args.expected_sha256 || null,
      runAs: args.run_as || null,
      actorId: principal.actor_id
    })) });
  }
};

const filePatch = {
  name: 'file_patch',
  description: 'Apply a deterministic exact-text replacement to a UTF-8 file. Use for localized edits after file_read; pass file_read.sha256 as expected_sha256 whenever available so stale edits fail closed.',
  schema: {
    profile: profileSchema,
    path: pathSchema,
    run_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/).optional().describe('Optional local user to execute as via sudo -n -u'),
    old_text: z.string().min(1).max(1024 * 1024),
    new_text: z.string().max(1024 * 1024),
    expected_count: z.number().int().min(1).max(1000).optional().default(1),
    expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe('Optional SHA-256 guard from a prior file_read; patch fails if the file changed'),
    max_bytes: z.number().int().min(1).max(2 * 1024 * 1024).optional().default(2 * 1024 * 1024)
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult({ success: true, ...(await service.filePatch(args.profile, args.path, args.old_text, args.new_text, {
      expectedCount: args.expected_count || 1,
      expectedSha256: args.expected_sha256 || null,
      maxBytes: args.max_bytes || 2 * 1024 * 1024,
      runAs: args.run_as || null,
      actorId: principal.actor_id
    })) });
  }
};

const processStart = {
  name: 'process_start',
  description: 'Start a long-running command in a managed detached tmux session. Use for servers, watchers, workers, or E2E support processes that outlive one call; use check_run or workspace_exec for finite commands.',
  schema: {
    profile: profileSchema,
    command: z.string().min(1).max(32000),
    cwd: z.string().max(2000).optional(),
    run_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/).optional().describe('Optional local user to execute as via sudo -n -u'),
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult({ success: true, ...(await service.processStart(args.profile, args.command, {
      cwd: args.cwd,
      runAs: args.run_as || null,
      actorId: principal.actor_id
    })) });
  }
};

const processStatus = {
  name: 'process_status',
  description: 'Inspect state, exit code, PID, and recent output for a process_start process. Use for lifecycle/state checks; use process_logs with a cursor for repeated incremental output reads.',
  schema: {
    profile: profileSchema,
    process_id: processIdSchema,
    lines: z.number().int().min(1).max(1000).optional().default(200)
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult(await service.processStatus(args.profile, args.process_id, {
      lines: args.lines || 200,
      actorId: principal.actor_id
    }));
  }
};

const processStop = {
  name: 'process_stop',
  description: 'Stop and clean up a managed process. Use when a process_start workload is finished or must be cancelled; sends Ctrl-C first and force-cleans after the grace period when requested.',
  schema: {
    profile: profileSchema,
    process_id: processIdSchema,
    force: z.boolean().optional().default(true),
    grace_ms: z.number().int().min(100).max(5000).optional().default(1000),
    lines: z.number().int().min(1).max(1000).optional().default(200)
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult({ success: true, ...(await service.processStop(args.profile, args.process_id, {
      force: args.force !== false,
      graceMs: args.grace_ms || 1000,
      lines: args.lines || 200,
      actorId: principal.actor_id
    })) });
  }
};


const repoSnapshot = {
  name: 'repo_snapshot',
  description: 'Return branch, HEAD, upstream, dirty state, ahead/behind counts, changed files, and optional merge-base in one structured call. Use near the start of a repository task before modifying source.',
  schema: {
    profile: profileSchema,
    repo: pathSchema,
    run_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/).optional().describe('Optional local user to execute as via sudo -n -u'),
    base: z.string().min(1).max(500).optional().describe('Optional Git base ref such as origin/main')
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult(await service.repoSnapshot(args.profile, args.repo, {
      runAs: args.run_as || null,
      base: args.base || null,
      actorId: principal.actor_id
    }));
  }
};

const gitDiff = {
  name: 'git_diff',
  description: 'Return a bounded structured Git diff with changed-file status, additions/deletions, and unified diff text. Prefer this for pre/post-change review instead of workspace_exec with raw git diff.',
  schema: {
    profile: profileSchema,
    repo: pathSchema,
    run_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/).optional().describe('Optional local user to execute as via sudo -n -u'),
    base: z.string().min(1).max(500).optional().default('HEAD').describe('Git base ref; defaults to HEAD'),
    paths: z.array(z.string().min(1).max(2000)).max(100).optional(),
    context_lines: z.number().int().min(0).max(50).optional().default(5),
    max_diff_bytes: z.number().int().min(1024).max(2 * 1024 * 1024).optional().default(512 * 1024)
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult(await service.gitDiff(args.profile, args.repo, {
      runAs: args.run_as || null,
      base: args.base || 'HEAD',
      paths: args.paths || [],
      contextLines: args.context_lines ?? 5,
      maxDiffBytes: args.max_diff_bytes || 512 * 1024,
      actorId: principal.actor_id
    }));
  }
};

const codeSearch = {
  name: 'code_search',
  description: 'Search source code with ripgrep and return bounded structured file/line/column matches. Use when the relevant file or location is unknown, preferably before broad file_read calls; this is exact/regex search, not semantic similarity search.',
  schema: {
    profile: profileSchema,
    cwd: pathSchema,
    query: z.string().min(1).max(4000),
    run_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/).optional().describe('Optional local user to execute as via sudo -n -u'),
    glob: z.string().min(1).max(1000).optional(),
    regex: z.boolean().optional().default(false),
    case_sensitive: z.boolean().optional().default(true),
    hidden: z.boolean().optional().default(false),
    max_results: z.number().int().min(1).max(500).optional().default(50)
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult(await service.codeSearch(args.profile, args.cwd, args.query, {
      runAs: args.run_as || null,
      glob: args.glob || null,
      regex: args.regex === true,
      caseSensitive: args.case_sensitive !== false,
      hidden: args.hidden === true,
      maxResults: args.max_results || 50,
      actorId: principal.actor_id
    }));
  }
};

const checkRun = {
  name: 'check_run',
  description: 'Run a finite test, lint, typecheck, formatter-check, or build command and return compact structured results. Prefer this over workspace_exec for checks where pass/fail and bounded failure context matter.',
  schema: {
    profile: profileSchema,
    command: z.string().min(1).max(32000),
    cwd: z.string().max(2000).optional(),
    run_as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/).optional().describe('Optional local user to execute as via sudo -n -u'),
    timeout_ms: z.number().int().min(100).max(300000).optional().default(120000),
    tail_lines: z.number().int().min(10).max(1000).optional().default(200)
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult(await service.checkRun(args.profile, args.command, {
      cwd: args.cwd || null,
      runAs: args.run_as || null,
      timeoutMs: args.timeout_ms || 120000,
      tailLines: args.tail_lines || 200,
      actorId: principal.actor_id
    }));
  }
};

const processLogs = {
  name: 'process_logs',
  description: 'Read only new output from a process_start process using a byte cursor. Prefer this for repeated polling so prior log output is not resent; use process_status for lifecycle/state checks.',
  schema: {
    profile: profileSchema,
    process_id: processIdSchema,
    cursor: z.number().int().min(0).optional().default(0),
    max_bytes: z.number().int().min(1024).max(512 * 1024).optional().default(64 * 1024)
  },
  domain: 'Local Development',
  requiredScope: 'bot_report.terminal',
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  async handler(args, service = terminalMcpService) {
    const principal = terminalPrincipal();
    return textResult(await service.processLogs(args.profile, args.process_id, {
      cursor: args.cursor || 0,
      maxBytes: args.max_bytes || 64 * 1024,
      actorId: principal.actor_id
    }));
  }
};

module.exports = {
  fileRead, fileWrite, filePatch,
  processStart, processStatus, processStop, processLogs,
  repoSnapshot, gitDiff, codeSearch, checkRun
};
