import path from 'node:path';
import type { ExecutionProfile, ExecutionTransport } from './executionContracts';
import { errorFields } from './workerProtocol';
import executionProfileRepository from '../repositories/executionProfileRepository';
import terminalAuditRepository from '../repositories/terminalAuditRepository';
import workerExecutionService from './workerExecutionService';
type ProfileRepository = Pick<typeof executionProfileRepository, 'findAll'>;
type AuditRepository = Pick<typeof terminalAuditRepository, 'log'>;
interface ActorOptions {
  actorId?: string | null;
}
interface CwdOptions extends ActorOptions {
  cwd?: string | null;
  timeoutMs?: number;
}
interface ReadOptions extends ActorOptions {
  maxBytes?: number;
  startLine?: number | null;
  endLine?: number | null;
  runAs?: string | null;
}
interface WriteOptions extends ActorOptions {
  createDirs?: boolean;
  expectedSha256?: string | null;
  runAs?: string | null;
}
interface PatchOptions extends ActorOptions {
  expectedCount?: number;
  expectedSha256?: string | null;
  maxBytes?: number;
  runAs?: string | null;
}
interface StartOptions extends ActorOptions {
  cwd?: string | null;
  runAs?: string | null;
}
interface StopOptions extends ActorOptions {
  force?: boolean;
  graceMs?: number;
  lines?: number;
}
interface RepoOptions extends ActorOptions {
  runAs?: string | null;
  base?: string | null;
}
interface DiffOptions extends ActorOptions {
  runAs?: string | null;
  base?: string;
  paths?: string[];
  contextLines?: number;
  maxDiffBytes?: number;
}
interface SearchOptions extends ActorOptions {
  runAs?: string | null;
  glob?: string | null;
  regex?: boolean;
  caseSensitive?: boolean;
  hidden?: boolean;
  maxResults?: number;
}
interface CheckOptions extends ActorOptions {
  cwd?: string | null;
  runAs?: string | null;
  timeoutMs?: number;
  tailLines?: number;
}
interface LogsOptions extends ActorOptions {
  cursor?: number;
  maxBytes?: number;
}
interface TerminalOptions {
  profiles?: ProfileRepository;
  audit?: AuditRepository;
  worker?: ExecutionTransport;
}
interface CheckSummary {
  tests: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  errors: number | null;
  assertions: number | null;
}
interface DiffFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}
interface RipgrepMessage {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    submatches?: { start?: number }[];
    lines?: { text?: string };
  };
}

function terminalServiceError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function normalizeCapturedText(text: unknown, lines: number) {
  const rows = String(text || '').split('\n');
  while (rows.length && rows.at(-1)?.trim() === '') rows.pop();
  return {
    text: rows.slice(-lines).join('\n'),
    lines: Math.min(rows.length, lines),
  };
}

function canonicalizeWorkspaceCwd(targetCwd: unknown) {
  if (targetCwd === null || targetCwd === undefined || targetCwd === '') return null;
  if (typeof targetCwd !== 'string') {
    throw terminalServiceError('INVALID_CWD', 'cwd must be a string.');
  }
  if (/[\x00-\x1f\x7f]/.test(targetCwd)) {
    throw terminalServiceError('INVALID_CWD', 'Control characters are not allowed in cwd.');
  }
  const normalized = targetCwd.trim();
  if (!normalized) return null;
  return path.posix.normalize(normalized);
}

function canonicalizeRunAs(runAs: unknown) {
  if (runAs === null || runAs === undefined || runAs === '') return null;
  if (typeof runAs !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(runAs.trim())) {
    throw terminalServiceError('INVALID_RUN_AS', 'run_as must be a valid local username.');
  }
  return runAs.trim();
}

function shellQuote(value: unknown) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function canonicalizeGitRef(ref: unknown) {
  if (ref === null || ref === undefined || ref === '') return null;
  if (typeof ref !== 'string')
    throw terminalServiceError('INVALID_GIT_REF', 'Git ref must be a string.');
  const value = ref.trim();
  if (!value || value.length > 500 || value.startsWith('-') || /[\x00-\x1f\x7f]/.test(value)) {
    throw terminalServiceError('INVALID_GIT_REF', 'Git ref is invalid.');
  }
  return value;
}

function tailText(text: unknown, lines: number) {
  const rows = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows.slice(-Math.max(1, Number(lines) || 200)).join('\n');
}

function parseCheckSummary(text: unknown) {
  const value = String(text || '');
  const summary: CheckSummary = {
    tests: null,
    passed: null,
    failed: null,
    skipped: null,
    errors: null,
    assertions: null,
  };
  const set = (key: keyof CheckSummary, match: RegExpMatchArray | null) => {
    if (match) summary[key] = Number(match[1]);
  };

  set('tests', value.match(/^# tests\s+(\d+)/m));
  set('passed', value.match(/^# pass\s+(\d+)/m));
  set('failed', value.match(/^# fail\s+(\d+)/m));
  set('skipped', value.match(/^# skipped\s+(\d+)/m));

  const php = value.match(
    /Tests:\s*(\d+)(?:,\s*Assertions:\s*(\d+))?(?:,\s*Failures:\s*(\d+))?(?:,\s*Errors:\s*(\d+))?(?:,\s*Skipped:\s*(\d+))?/i,
  );
  if (php) {
    summary.tests = Number(php[1]);
    if (php[2] !== undefined) summary.assertions = Number(php[2]);
    if (php[3] !== undefined) summary.failed = Number(php[3]);
    if (php[4] !== undefined) summary.errors = Number(php[4]);
    if (php[5] !== undefined) summary.skipped = Number(php[5]);
    if (summary.passed === null && summary.tests !== null) {
      summary.passed = Math.max(
        0,
        summary.tests - (summary.failed || 0) - (summary.errors || 0) - (summary.skipped || 0),
      );
    }
  }

  if (summary.tests === null || summary.passed === null || summary.failed === null) {
    const counts: Record<string, number> = {};
    for (const match of value.matchAll(
      /(\d+)\s+(passed|failed|skipped|errors?|xfailed|xpassed)\b/gi,
    )) {
      counts[match[2].toLowerCase()] = Number(match[1]);
    }
    if (summary.passed === null && counts.passed !== undefined) summary.passed = counts.passed;
    if (summary.failed === null && counts.failed !== undefined) summary.failed = counts.failed;
    if (summary.skipped === null && counts.skipped !== undefined) summary.skipped = counts.skipped;
    if (summary.errors === null) {
      if (counts.errors !== undefined) summary.errors = counts.errors;
      else if (counts.error !== undefined) summary.errors = counts.error;
    }
    if (
      summary.tests === null &&
      [summary.passed, summary.failed, summary.skipped, summary.errors].some((x) => x !== null)
    ) {
      summary.tests =
        (summary.passed || 0) +
        (summary.failed || 0) +
        (summary.skipped || 0) +
        (summary.errors || 0);
    }
  }

  return Object.values(summary).some((value) => value !== null) ? summary : null;
}

function extractFailureLines(text: unknown, limit = 20) {
  const failures: string[] = [];
  for (const raw of String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (
      /^not ok\b/i.test(line) ||
      /^FAIL\b/.test(line) ||
      /\bAssertionError\b/.test(line) ||
      /^FAILED\b/.test(line) ||
      /^Error:\s/.test(line)
    ) {
      failures.push(line.slice(0, 1000));
      if (failures.length >= limit) break;
    }
  }
  return failures;
}

function canonicalizeArtifactPath(artifactPath: unknown) {
  if (typeof artifactPath !== 'string' || !artifactPath.trim()) {
    throw terminalServiceError(
      'INVALID_ARTIFACT_PATH',
      'Artifact path must be a non-empty string.',
    );
  }
  if (/[\x00-\x1f\x7f]/.test(artifactPath)) {
    throw terminalServiceError(
      'INVALID_ARTIFACT_PATH',
      'Control characters are not allowed in artifact path.',
    );
  }
  return path.posix.normalize(artifactPath.trim());
}

class TerminalMcpService {
  profiles: ProfileRepository;
  audit: AuditRepository;
  worker: ExecutionTransport;
  constructor({
    profiles = executionProfileRepository,
    audit = terminalAuditRepository,
    worker = workerExecutionService,
  }: TerminalOptions = {}) {
    this.profiles = profiles;
    this.audit = audit;
    this.worker = worker;
  }

  ownerUserIdForActor(actorId: string | null) {
    const match = /^principal:user:([A-Za-z0-9_.-]{1,96})$/.exec(String(actorId || ''));
    return match ? match[1] : null;
  }

  async list({ actorId = null }: ActorOptions = {}) {
    const ownerUserId = this.ownerUserIdForActor(actorId);
    return (await this.profiles.findAll({ ownerUserId })).map((profile) => ({
      name: profile.name,
      description: profile.description || null,
      enabled: Boolean(profile.enabled),
    }));
  }

  async findProfile(
    name: string,
    { actorId = null }: ActorOptions = {},
  ): Promise<ExecutionProfile> {
    if (typeof name !== 'string' || !name.trim()) {
      throw terminalServiceError('PROFILE_NOT_FOUND', 'Execution Profile not found.');
    }
    const ownerUserId = this.ownerUserIdForActor(actorId);
    const normalized = name.trim().toLowerCase();
    const matches = (await this.profiles.findAll({ ownerUserId })).filter(
      (item) => item.name.toLowerCase() === normalized,
    );
    if (matches.length !== 1)
      throw terminalServiceError('PROFILE_NOT_FOUND', 'Execution Profile not found or ambiguous.');
    const profile = matches[0];
    if (!profile.enabled)
      throw terminalServiceError('PROFILE_DISABLED', 'This Execution Profile is disabled.');
    if (profile.transport !== 'worker' || !profile.worker_id)
      throw terminalServiceError(
        'WORKER_ONLY',
        'Only enrolled Worker execution targets are supported.',
      );
    return profile;
  }

  executorFor(profile: ExecutionProfile): ExecutionTransport {
    if (profile.transport !== 'worker' || !profile.worker_id)
      throw terminalServiceError('WORKER_ONLY', 'Direct SSH execution is disabled.');
    return this.worker;
  }

  log(
    profile: ExecutionProfile,
    actorId: string | null,
    eventType: string,
    outcome: string,
    detailCode: string | null = null,
  ) {
    Promise.resolve(
      this.audit.log({
        profileId: profile.id,
        profileName: profile.name,
        actorId: actorId || null,
        eventType,
        outcome,
        detailCode,
      }),
    ).catch(() => {});
  }

  async status(name: string, { actorId = null }: ActorOptions = {}) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const inspection = await this.executorFor(profile).inspectProfile(profile, null);
      const status = inspection.pane_count === 1 ? 'READY' : 'ATTENTION_REQUIRED';
      this.log(profile, actorId, 'MCP_STATUS_CHECK', 'SUCCESS', status);
      return {
        profile: profile.name,
        status,
        pane_count: inspection.pane_count,
        target_pane: inspection.target_pane,
        pane_current_command: inspection.pane_current_command,
        panes: inspection.panes,
      };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_STATUS_CHECK',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async send(
    name: string,
    text: string,
    { submit = true, actorId = null }: ActorOptions & { submit?: boolean } = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const result = await this.executorFor(profile).sendText(profile, null, text, { submit });
      this.log(profile, actorId, 'MCP_INPUT_SENT', 'SUCCESS', submit ? 'SUBMITTED' : 'PASTED');
      return {
        profile: profile.name,
        submitted: submit,
        target_pane: result.target_pane,
        pane_current_command: result.pane_current_command,
      };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_INPUT_SENT',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async read(name: string, lines = 200, { actorId = null }: ActorOptions = {}) {
    const profile = await this.findProfile(name, { actorId });
    try {
      // captureText already reads the full tmux history before slicing. Asking for
      // the internal maximum lets us remove blank viewport rows first, then honor
      // the MCP caller's requested line count.
      const result = await this.executorFor(profile).readText(profile, null, 10000);
      const normalized = normalizeCapturedText(result.text, lines);
      this.log(profile, actorId, 'MCP_OUTPUT_READ', 'SUCCESS');
      return {
        profile: profile.name,
        ...result,
        ...normalized,
      };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_OUTPUT_READ',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async workspaceExec(
    name: string,
    command: string,
    { cwd = null, timeoutMs = 30000, actorId = null }: CwdOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      if (typeof command !== 'string' || !command.trim()) {
        throw terminalServiceError('INVALID_COMMAND', 'Command must be a non-empty string.');
      }
      if (command.length > 32000) {
        throw terminalServiceError('INVALID_COMMAND', 'Command exceeds maximum length.');
      }
      if (command.includes('\0')) {
        throw terminalServiceError('INVALID_COMMAND', 'Command contains null bytes.');
      }
      const resolvedCwd = canonicalizeWorkspaceCwd(cwd);
      const result = await this.executorFor(profile).execWorkspaceCommand(profile, null, command, {
        cwd: resolvedCwd,
        timeoutMs,
      });
      const detailCode = result.exit_code === 0 ? 'EXEC_OK' : `EXEC_EXIT_${result.exit_code}`;
      this.log(profile, actorId, 'MCP_WORKSPACE_EXEC', 'SUCCESS', detailCode);
      return {
        profile: profile.name,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: result.duration_ms,
        cwd: resolvedCwd,
        stdout_truncated: result.stdout_truncated,
        stderr_truncated: result.stderr_truncated,
      };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_WORKSPACE_EXEC',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async fileRead(
    name: string,
    filePath: string,
    {
      maxBytes = 512 * 1024,
      startLine = null,
      endLine = null,
      runAs = null,
      actorId = null,
    }: ReadOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const resolvedPath = canonicalizeArtifactPath(filePath);
      const resolvedRunAs = canonicalizeRunAs(runAs);
      const result = await this.executorFor(profile).collectArtifact(profile, null, resolvedPath, {
        maxBytes,
        runAs: resolvedRunAs,
      });
      if (!result.is_text)
        throw terminalServiceError(
          'BINARY_FILE_UNSUPPORTED',
          'file_read supports text files only.',
        );
      const rows = String(result.text ?? '').split('\n');
      const totalLines = rows.length;
      const start = startLine == null ? 1 : Number(startLine);
      const end = endLine == null ? totalLines : Number(endLine);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw terminalServiceError('INVALID_LINE_RANGE', 'Invalid file line range.');
      }
      const selected = rows.slice(start - 1, Math.min(end, totalLines));
      this.log(profile, actorId, 'MCP_FILE_READ', 'SUCCESS', 'FILE_READ');
      return {
        profile: profile.name,
        path: resolvedPath,
        real_path: result.real_path,
        sha256: result.sha256,
        size: result.size,
        total_lines: totalLines,
        start_line: start,
        end_line: Math.min(end, totalLines),
        text: selected.join('\n'),
        truncated: start > 1 || end < totalLines,
      };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_FILE_READ',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async fileWrite(
    name: string,
    filePath: string,
    content: string,
    { createDirs = false, expectedSha256 = null, runAs = null, actorId = null }: WriteOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const resolvedPath = canonicalizeArtifactPath(filePath);
      const resolvedRunAs = canonicalizeRunAs(runAs);
      if (typeof content !== 'string')
        throw terminalServiceError('INVALID_FILE_CONTENT', 'File content must be text.');
      if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
        throw terminalServiceError('FILE_TOO_LARGE', 'file_write content exceeds 2 MiB.');
      }
      if (expectedSha256) {
        if (!/^[a-f0-9]{64}$/i.test(expectedSha256))
          throw terminalServiceError(
            'INVALID_SHA256',
            'expected_sha256 must be a 64-character SHA-256 hex string.',
          );
        const current = await this.executorFor(profile).collectArtifact(
          profile,
          null,
          resolvedPath,
          { maxBytes: 2 * 1024 * 1024, runAs: resolvedRunAs },
        );
        if (current.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
          throw terminalServiceError(
            'FILE_CHANGED',
            'File SHA-256 does not match expected_sha256.',
          );
        }
      }
      await this.executorFor(profile).writeTextFile(profile, null, resolvedPath, content, {
        createDirs,
        runAs: resolvedRunAs,
      });
      const written = await this.executorFor(profile).collectArtifact(profile, null, resolvedPath, {
        maxBytes: 2 * 1024 * 1024,
        runAs: resolvedRunAs,
      });
      this.log(profile, actorId, 'MCP_FILE_WRITE', 'SUCCESS', 'FILE_WRITTEN');
      return {
        profile: profile.name,
        path: resolvedPath,
        real_path: written.real_path,
        size: written.size,
        sha256: written.sha256,
        created_dirs: Boolean(createDirs),
      };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_FILE_WRITE',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async filePatch(
    name: string,
    filePath: string,
    oldText: string,
    newText: string,
    {
      expectedCount = 1,
      expectedSha256 = null,
      maxBytes = 2 * 1024 * 1024,
      runAs = null,
      actorId = null,
    }: PatchOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const resolvedPath = canonicalizeArtifactPath(filePath);
      const resolvedRunAs = canonicalizeRunAs(runAs);
      if (typeof oldText !== 'string' || !oldText.length)
        throw terminalServiceError('INVALID_PATCH', 'old_text must be a non-empty string.');
      if (typeof newText !== 'string')
        throw terminalServiceError('INVALID_PATCH', 'new_text must be a string.');
      if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 1000) {
        throw terminalServiceError(
          'INVALID_PATCH',
          'expected_count must be an integer from 1 to 1000.',
        );
      }
      const current = await this.executorFor(profile).collectArtifact(profile, null, resolvedPath, {
        maxBytes,
        runAs: resolvedRunAs,
      });
      if (expectedSha256) {
        if (!/^[a-f0-9]{64}$/i.test(expectedSha256))
          throw terminalServiceError(
            'INVALID_SHA256',
            'expected_sha256 must be a 64-character SHA-256 hex string.',
          );
        if (current.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
          throw terminalServiceError(
            'FILE_CHANGED',
            'File SHA-256 does not match expected_sha256.',
          );
        }
      }
      if (!current.is_text)
        throw terminalServiceError(
          'BINARY_FILE_UNSUPPORTED',
          'file_patch supports text files only.',
        );
      const source = String(current.text ?? '');
      const actualCount = source.split(oldText).length - 1;
      if (actualCount !== expectedCount) {
        throw terminalServiceError(
          'PATCH_CONTEXT_MISMATCH',
          `Expected ${expectedCount} exact match(es), found ${actualCount}.`,
        );
      }
      const updated = source.split(oldText).join(newText);
      if (Buffer.byteLength(updated, 'utf8') > maxBytes)
        throw terminalServiceError('FILE_TOO_LARGE', 'Patched file exceeds max_bytes.');
      await this.executorFor(profile).writeTextFile(profile, null, resolvedPath, updated, {
        runAs: resolvedRunAs,
      });
      const written = await this.executorFor(profile).collectArtifact(profile, null, resolvedPath, {
        maxBytes,
        runAs: resolvedRunAs,
      });
      this.log(profile, actorId, 'MCP_FILE_PATCH', 'SUCCESS', `PATCHED_${actualCount}`);
      return {
        profile: profile.name,
        path: resolvedPath,
        replacements: actualCount,
        before_sha256: current.sha256,
        after_sha256: written.sha256,
        size: written.size,
      };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_FILE_PATCH',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async processStart(
    name: string,
    command: string,
    { cwd = null, runAs = null, actorId = null }: StartOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      if (
        typeof command !== 'string' ||
        !command.trim() ||
        command.length > 32000 ||
        command.includes('\0')
      ) {
        throw terminalServiceError(
          'INVALID_COMMAND',
          'Command must be non-empty, contain no null bytes, and be at most 32000 characters.',
        );
      }
      const resolvedCwd = canonicalizeWorkspaceCwd(cwd);
      const resolvedRunAs = canonicalizeRunAs(runAs);
      const result = await this.executorFor(profile).startManagedProcess(profile, null, command, {
        cwd: resolvedCwd,
        runAs: resolvedRunAs,
      });
      this.log(profile, actorId, 'MCP_PROCESS_START', 'SUCCESS', result.process_id);
      return { profile: profile.name, cwd: resolvedCwd, ...result };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_PROCESS_START',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async processStatus(
    name: string,
    processId: string,
    { lines = 200, actorId = null }: ActorOptions & { lines?: number } = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const result = await this.executorFor(profile).getManagedProcessStatus(
        profile,
        null,
        processId,
        { lines },
      );
      this.log(profile, actorId, 'MCP_PROCESS_STATUS', 'SUCCESS', result.state);
      return { profile: profile.name, ...result };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_PROCESS_STATUS',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async processStop(
    name: string,
    processId: string,
    { force = true, graceMs = 1000, lines = 200, actorId = null }: StopOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const result = await this.executorFor(profile).stopManagedProcess(profile, null, processId, {
        force,
        graceMs,
        lines,
      });
      this.log(
        profile,
        actorId,
        'MCP_PROCESS_STOP',
        'SUCCESS',
        result.forced ? 'FORCED' : 'GRACEFUL',
      );
      return { profile: profile.name, ...result };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_PROCESS_STOP',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async repoSnapshot(
    name: string,
    repo: string,
    { runAs = null, base = null, actorId = null }: RepoOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    const resolvedRepo = canonicalizeWorkspaceCwd(repo);
    const resolvedRunAs = canonicalizeRunAs(runAs);
    const resolvedBase = canonicalizeGitRef(base);
    try {
      const baseScript = resolvedBase
        ? `base_sha=$(git rev-parse --verify ${shellQuote(resolvedBase + '^{commit}')} 2>/dev/null) || exit 42\nmerge_base=$(git merge-base HEAD ${shellQuote(resolvedBase)} 2>/dev/null || true)\nprintf 'BASE\\t%s\\nMERGE_BASE\\t%s\\n' "$base_sha" "$merge_base"\n`
        : `printf 'BASE\\t\\nMERGE_BASE\\t\\n'\n`;
      const script =
        `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 41\n` +
        `printf 'ROOT\\t%s\\n' "$(git rev-parse --show-toplevel)"\n` +
        `printf 'BRANCH\\t%s\\n' "$(git symbolic-ref --short -q HEAD || true)"\n` +
        `printf 'HEAD\\t%s\\n' "$(git rev-parse HEAD)"\n` +
        `upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)\n` +
        `printf 'UPSTREAM\\t%s\\n' "$upstream"\n` +
        `if [ -n "$upstream" ]; then counts=$(git rev-list --left-right --count HEAD..."$upstream" 2>/dev/null || printf '0\\t0'); else counts='0\\t0'; fi\n` +
        `printf 'COUNTS\\t%s\\n' "$counts"\n` +
        baseScript +
        `printf '__BR_STATUS__\\n'\n` +
        `git -c core.quotepath=false status --porcelain=v1 --untracked-files=normal\n`;
      const result = await this.executorFor(profile).execWorkspaceCommand(profile, null, script, {
        cwd: resolvedRepo,
        runAs: resolvedRunAs,
        timeoutMs: 30000,
        maxOutputBytes: 512 * 1024,
      });
      if (result.exit_code === 41)
        throw terminalServiceError('NOT_A_GIT_REPOSITORY', 'repo is not a Git repository.');
      if (result.exit_code === 42)
        throw terminalServiceError('INVALID_GIT_REF', 'base Git ref could not be resolved.');
      if (result.exit_code !== 0)
        throw terminalServiceError(
          'GIT_COMMAND_FAILED',
          result.stderr || 'Unable to inspect Git repository.',
        );
      const [metaText, statusText = ''] = result.stdout.split('__BR_STATUS__\n', 2);
      const meta: Record<string, string> = {};
      for (const line of metaText.split(/\r?\n/)) {
        const tab = line.indexOf('\t');
        if (tab > 0) meta[line.slice(0, tab)] = line.slice(tab + 1);
      }
      const countParts = String(meta.COUNTS || '0\t0').split('\t');
      const changedFiles = statusText
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const status = line.slice(0, 2);
          const rawPath = line.length > 3 ? line.slice(3) : '';
          const pathValue = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath;
          return { path: pathValue, status };
        });
      const snapshot = {
        profile: profile.name,
        repo: resolvedRepo,
        root: meta.ROOT || null,
        branch: meta.BRANCH || null,
        head: meta.HEAD || null,
        upstream: meta.UPSTREAM || null,
        dirty: changedFiles.length > 0,
        ahead: Number(countParts[0]) || 0,
        behind: Number(countParts[1]) || 0,
        changed_files: changedFiles,
        base: resolvedBase,
        base_sha: meta.BASE || null,
        merge_base: meta.MERGE_BASE || null,
      };
      this.log(
        profile,
        actorId,
        'MCP_REPO_SNAPSHOT',
        'SUCCESS',
        snapshot.dirty ? 'DIRTY' : 'CLEAN',
      );
      return snapshot;
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_REPO_SNAPSHOT',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async gitDiff(
    name: string,
    repo: string,
    {
      runAs = null,
      base = 'HEAD',
      paths = [],
      contextLines = 5,
      maxDiffBytes = 512 * 1024,
      actorId = null,
    }: DiffOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    const resolvedRepo = canonicalizeWorkspaceCwd(repo);
    const resolvedRunAs = canonicalizeRunAs(runAs);
    const resolvedBase = canonicalizeGitRef(base) || 'HEAD';
    const selectedPaths = Array.isArray(paths) ? paths : [];
    if (
      selectedPaths.length > 100 ||
      selectedPaths.some(
        (item) => typeof item !== 'string' || !item || /[\x00-\x1f\x7f]/.test(item),
      )
    ) {
      throw terminalServiceError(
        'INVALID_PATH_FILTER',
        'paths must contain at most 100 non-empty path strings.',
      );
    }
    const context = Math.max(0, Math.min(Number(contextLines) || 0, 50));
    const limit = Math.max(1024, Math.min(Number(maxDiffBytes) || 512 * 1024, 2 * 1024 * 1024));
    const pathArgs = selectedPaths.map(shellQuote).join(' ');
    const suffix = ` ${shellQuote(resolvedBase)} --${pathArgs ? ' ' + pathArgs : ''}`;
    try {
      const metaCommand =
        `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 41\n` +
        `git rev-parse --verify ${shellQuote(resolvedBase + '^{commit}')} >/dev/null 2>&1 || exit 42\n` +
        `printf '__BR_NAME_STATUS__\\n'\n` +
        `git -c core.quotepath=false diff --name-status --find-renames${suffix}\n` +
        `printf '__BR_NUMSTAT__\\n'\n` +
        `git -c core.quotepath=false diff --numstat --find-renames${suffix}\n`;
      const metaResult = await this.executorFor(profile).execWorkspaceCommand(
        profile,
        null,
        metaCommand,
        {
          cwd: resolvedRepo,
          runAs: resolvedRunAs,
          timeoutMs: 30000,
          maxOutputBytes: 512 * 1024,
        },
      );
      if (metaResult.exit_code === 41)
        throw terminalServiceError('NOT_A_GIT_REPOSITORY', 'repo is not a Git repository.');
      if (metaResult.exit_code === 42)
        throw terminalServiceError('INVALID_GIT_REF', 'base Git ref could not be resolved.');
      if (metaResult.exit_code !== 0)
        throw terminalServiceError(
          'GIT_COMMAND_FAILED',
          metaResult.stderr || 'Unable to inspect Git diff.',
        );

      const diffResult = await this.executorFor(profile).execWorkspaceCommand(
        profile,
        null,
        `git -c color.ui=false diff --no-ext-diff --find-renames --unified=${context}${suffix}`,
        {
          cwd: resolvedRepo,
          runAs: resolvedRunAs,
          timeoutMs: 30000,
          maxOutputBytes: limit,
        },
      );
      if (diffResult.exit_code !== 0)
        throw terminalServiceError(
          'GIT_COMMAND_FAILED',
          diffResult.stderr || 'Unable to read Git diff.',
        );

      const nameMarker = '__BR_NAME_STATUS__\n';
      const statMarker = '__BR_NUMSTAT__\n';
      const afterName = metaResult.stdout.split(nameMarker, 2)[1] || '';
      const [nameText, statText = ''] = afterName.split(statMarker, 2);
      const files: DiffFile[] = [];
      const byPath = new Map<string, DiffFile>();
      for (const line of nameText.split(/\r?\n/).filter(Boolean)) {
        const parts = line.split('\t');
        const code = parts[0] || '';
        const pathValue = code.startsWith('R') || code.startsWith('C') ? parts[2] : parts[1];
        if (!pathValue) continue;
        const item = { path: pathValue, status: code, additions: null, deletions: null };
        files.push(item);
        byPath.set(pathValue, item);
      }
      for (const line of statText.split(/\r?\n/).filter(Boolean)) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const pathValue = parts.slice(2).join('\t');
        const target = byPath.get(pathValue);
        if (target) {
          target.additions = parts[0] === '-' ? null : Number(parts[0]);
          target.deletions = parts[1] === '-' ? null : Number(parts[1]);
        }
      }
      const output = {
        profile: profile.name,
        repo: resolvedRepo,
        base: resolvedBase,
        files,
        file_count: files.length,
        diff: diffResult.stdout,
        diff_bytes: Buffer.byteLength(diffResult.stdout, 'utf8'),
        diff_truncated: Boolean(diffResult.stdout_truncated),
      };
      this.log(profile, actorId, 'MCP_GIT_DIFF', 'SUCCESS', `FILES_${files.length}`);
      return output;
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_GIT_DIFF',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async codeSearch(
    name: string,
    cwd: string,
    query: string,
    {
      runAs = null,
      glob = null,
      regex = false,
      caseSensitive = true,
      hidden = false,
      maxResults = 50,
      actorId = null,
    }: SearchOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    const resolvedCwd = canonicalizeWorkspaceCwd(cwd);
    const resolvedRunAs = canonicalizeRunAs(runAs);
    if (typeof query !== 'string' || !query || query.length > 4000 || query.includes('\0')) {
      throw terminalServiceError(
        'INVALID_SEARCH_QUERY',
        'query must be a non-empty string up to 4000 characters.',
      );
    }
    if (glob !== null && (typeof glob !== 'string' || !glob || /[\x00-\x1f\x7f]/.test(glob))) {
      throw terminalServiceError(
        'INVALID_SEARCH_GLOB',
        'glob must be a non-empty string without control characters.',
      );
    }
    const limit = Math.max(1, Math.min(Number(maxResults) || 50, 500));
    const flags = ['--json', '--line-number', '--no-heading', '--max-count', String(limit)];
    if (!regex) flags.push('--fixed-strings');
    if (!caseSensitive) flags.push('--ignore-case');
    if (hidden) flags.push('--hidden');
    if (glob) flags.push('--glob', glob);
    const command = `rg ${flags.map(shellQuote).join(' ')} -- ${shellQuote(query)} .`;
    try {
      const result = await this.executorFor(profile).execWorkspaceCommand(profile, null, command, {
        cwd: resolvedCwd,
        runAs: resolvedRunAs,
        timeoutMs: 30000,
        maxOutputBytes: 2 * 1024 * 1024,
      });
      if (![0, 1].includes(result.exit_code)) {
        if (result.exit_code === 127 || /rg: not found|ripgrep.*not found/i.test(result.stderr)) {
          throw terminalServiceError(
            'RIPGREP_NOT_AVAILABLE',
            'ripgrep (rg) is not available on the SSH host.',
          );
        }
        throw terminalServiceError('CODE_SEARCH_FAILED', result.stderr || 'ripgrep search failed.');
      }
      const matches: {
        file: string | null;
        line: number | null;
        column: number | null;
        text: string;
      }[] = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        if (!line) continue;
        let item: RipgrepMessage;
        try {
          item = JSON.parse(line) as RipgrepMessage;
        } catch (_) {
          continue;
        }
        if (item.type !== 'match' || !item.data) continue;
        const submatch = Array.isArray(item.data.submatches) ? item.data.submatches[0] : null;
        matches.push({
          file: item.data.path?.text || null,
          line: item.data.line_number || null,
          column:
            submatch && typeof submatch.start === 'number' && Number.isInteger(submatch.start)
              ? submatch.start + 1
              : null,
          text: String(item.data.lines?.text || '').replace(/\r?\n$/, ''),
        });
        if (matches.length >= limit) break;
      }
      const output = {
        profile: profile.name,
        cwd: resolvedCwd,
        query,
        matches,
        match_count: matches.length,
        truncated: Boolean(result.stdout_truncated) || matches.length >= limit,
      };
      this.log(profile, actorId, 'MCP_CODE_SEARCH', 'SUCCESS', `MATCHES_${matches.length}`);
      return output;
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_CODE_SEARCH',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async checkRun(
    name: string,
    command: string,
    {
      cwd = null,
      runAs = null,
      timeoutMs = 120000,
      tailLines = 200,
      actorId = null,
    }: CheckOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    const resolvedCwd = canonicalizeWorkspaceCwd(cwd);
    const resolvedRunAs = canonicalizeRunAs(runAs);
    if (
      typeof command !== 'string' ||
      !command.trim() ||
      command.length > 32000 ||
      command.includes('\0')
    ) {
      throw terminalServiceError(
        'INVALID_COMMAND',
        'Command must be non-empty, contain no null bytes, and be at most 32000 characters.',
      );
    }
    try {
      const result = await this.executorFor(profile).execWorkspaceCommand(profile, null, command, {
        cwd: resolvedCwd,
        runAs: resolvedRunAs,
        timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
      });
      const combined = `${result.stdout}\n${result.stderr}`;
      const summary = parseCheckSummary(combined);
      const failures = extractFailureLines(combined);
      const output = {
        profile: profile.name,
        cwd: resolvedCwd,
        status: result.exit_code === 0 ? 'PASS' : 'FAIL',
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        summary,
        failures,
        stdout_tail: tailText(result.stdout, tailLines),
        stderr_tail: tailText(result.stderr, tailLines),
        stdout_truncated: Boolean(result.stdout_truncated),
        stderr_truncated: Boolean(result.stderr_truncated),
      };
      this.log(profile, actorId, 'MCP_CHECK_RUN', 'SUCCESS', output.status);
      return output;
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_CHECK_RUN',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async processLogs(
    name: string,
    processId: string,
    { cursor = 0, maxBytes = 64 * 1024, actorId = null }: LogsOptions = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const result = await this.executorFor(profile).readManagedProcessLogs(
        profile,
        null,
        processId,
        { cursor, maxBytes },
      );
      this.log(profile, actorId, 'MCP_PROCESS_LOGS', 'SUCCESS', result.eof ? 'EOF' : 'MORE');
      return { profile: profile.name, ...result };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_PROCESS_LOGS',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async interrupt(name: string, { actorId = null }: ActorOptions = {}) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const result = await this.executorFor(profile).sendInterrupt(profile, null);
      this.log(profile, actorId, 'MCP_TERMINAL_INTERRUPT', 'SUCCESS', 'INTERRUPT_SENT');
      return {
        profile: profile.name,
        interrupted: true,
        target_pane: result.target_pane,
        pane_current_command: result.pane_current_command,
      };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_TERMINAL_INTERRUPT',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }

  async artifactCollect(
    name: string,
    artifactPath: string,
    { maxBytes = 2 * 1024 * 1024, actorId = null }: ActorOptions & { maxBytes?: number } = {},
  ) {
    const profile = await this.findProfile(name, { actorId });
    try {
      const resolvedPath = canonicalizeArtifactPath(artifactPath);
      const result = await this.executorFor(profile).collectArtifact(profile, null, resolvedPath, {
        maxBytes,
      });
      this.log(profile, actorId, 'MCP_ARTIFACT_COLLECT', 'SUCCESS', 'ARTIFACT_COLLECTED');
      return {
        profile: profile.name,
        ...result,
      };
    } catch (error) {
      this.log(
        profile,
        actorId,
        'MCP_ARTIFACT_COLLECT',
        'FAILED',
        errorFields(error).code || 'WORKER_EXECUTION_FAILED',
      );
      throw error;
    }
  }
}

const instance = Object.assign(new TerminalMcpService(), {
  TerminalMcpService,
  terminalServiceError,
  normalizeCapturedText,
  canonicalizeWorkspaceCwd,
  canonicalizeArtifactPath,
  canonicalizeRunAs,
});
export = instance;
