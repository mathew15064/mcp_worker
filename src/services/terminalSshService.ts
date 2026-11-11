import crypto from 'node:crypto';
import path from 'node:path';
import mime from 'mime-types';
import {Client, type ClientChannel, type ExecOptions} from 'ssh2';
import terminalProfileRepo = require('../repositories/terminalProfileRepository');
const {TMUX_SESSION_RE} = terminalProfileRepo;


interface SshProfile {host: string; port: number; username: string; tmux_session: string}
interface AbortOptions {signal?: AbortSignal}
interface SshOptions extends AbortOptions {runAs?: string | null}
interface ReadOptions extends AbortOptions {targetPane?: string | null}
interface CommandOptions extends SshOptions {cwd?: string | null; timeoutMs?: number; maxOutputBytes?: number}
interface FileOptions extends SshOptions {maxBytes?: number}
interface WriteOptions extends SshOptions {createDirs?: boolean}
interface InputOptions extends AbortOptions {timeoutMs?: number; maxStderrBytes?: number}
interface ProcessOptions extends SshOptions {cwd?: string | null}
interface ProcessReadOptions extends AbortOptions {lines?: number}
interface ProcessLogOptions extends AbortOptions {cursor?: number; maxBytes?: number}
interface ProcessStopOptions extends AbortOptions {force?: boolean; graceMs?: number; lines?: number}
interface InteractiveOptions extends AbortOptions {cols?: number; rows?: number; onState?: (value: string) => void}
interface SshConnection {client: Client}
interface PaneInspection {pane_count: number; panes: Array<{id: string; current_command: string | null}>; target_pane: string | null; pane_current_command: string | null}
interface ReadCapture {text: string; lines: number; truncated: boolean}
interface ProcessSnapshot {process_id: string; state: string; exit_code: number | null; pid: number | null; current_command: string | null; output: string; output_lines: number}
interface CommandResult {exit_code: number; stdout: string; stderr: string; duration_ms: number; stdout_truncated: boolean; stderr_truncated: boolean}
function codeOf(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function terminalError(code: string, message: string) {return Object.assign(new Error(message), {code});}

function shellQuote(value: unknown) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function validateRunAs(runAs: unknown) {
  if (runAs === null || runAs === undefined || runAs === '') return null;
  if (typeof runAs !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(runAs)) {
    throw terminalError('INVALID_RUN_AS', 'run_as must be a valid local username.');
  }
  return runAs;
}

function validateManagedProcessId(processId: unknown) {
  if (typeof processId !== 'string' || !/^brproc-[a-f0-9]{16}$/.test(processId)) {
    throw terminalError('INVALID_PROCESS_ID', 'Invalid managed process identifier.');
  }
  return processId;
}

function managedProcessLogPath(processId: unknown) {
  const id = validateManagedProcessId(processId);
  return `/tmp/bot-report-mcp-process/${id}.log`;
}

function sanitizeTerminalText(text: unknown) {
  return String(text || '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

class TerminalSshService {
  ClientClass: typeof Client;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  constructor({ ClientClass = Client, connectTimeoutMs = 10_000, commandTimeoutMs = 5_000 }: {ClientClass?: typeof Client; connectTimeoutMs?: number; commandTimeoutMs?: number} = {}) {
    this.ClientClass = ClientClass;
    this.connectTimeoutMs = connectTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
  }

  connect(profile: SshProfile, password: string, { signal }: AbortOptions = {}): Promise<Client> {
    return new Promise<Client>((resolve, reject) => {
      const client = new this.ClientClass();
      let settled = false;
      const abort = () => {
        finishReject();
        try { client.destroy?.(); } catch (_) {}
      };
      const timer = setTimeout(abort, this.connectTimeoutMs);
      const removeSetupListeners = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const finishReject = (error?: unknown) => {
        if (settled) return;
        settled = true;
        removeSetupListeners();
        try { client.end(); } catch (_) {}
        if (error !== null && typeof error === 'object' && 'level' in error && error.level === 'client-authentication') return reject(terminalError('SSH_AUTH_FAILED', 'SSH authentication failed.'));
        return reject(terminalError('SSH_CONNECT_FAILED', 'SSH connection failed.'));
      };

      client.once('ready', () => {
        if (settled) return;
        settled = true;
        removeSetupListeners();
        resolve(client);
      });
      client.on('error', finishReject);
      (client as NodeJS.EventEmitter).once('close',  finishReject);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();

      try {
        client.connect({
          host: profile.host,
          port: profile.port,
          username: profile.username,
          password,
          readyTimeout: this.connectTimeoutMs,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3
        });
      } catch (error) {
        finishReject(error);
      }
    });
  }

  execChannel(client: Client, command: string, options: ExecOptions = {}, signal?: AbortSignal): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', fail);
        (client as NodeJS.EventEmitter).removeListener('close',  fail);
        client.removeListener('error', fail);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { client.end(); } catch (_) {}
        reject(terminalError('SSH_CONNECT_FAILED', 'SSH command channel failed or timed out.'));
      };
      const timer = setTimeout(fail, this.commandTimeoutMs);
      signal?.addEventListener('abort', fail, { once: true });
      (client as NodeJS.EventEmitter).once('close',  fail);
      client.once('error', fail);
      if (signal?.aborted) return fail();
      try {
        client.exec(command, options, (error, stream) => {
          if (settled) { try { stream?.close(); } catch (_) {} return; }
          if (error) return fail();
          settled = true;
          cleanup();
          resolve(stream);
        });
      } catch (_) { fail(); }
    });
  }

  async execStatus(client: Client, command: string, signal?: AbortSignal): Promise<number> {
    const stream = await this.execChannel(client, command, {}, signal);
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', fail);
        (client as NodeJS.EventEmitter).removeListener('close',  fail);
        client.removeListener('error', fail);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { stream.close(); } catch (_) {}
        reject(terminalError('SSH_CONNECT_FAILED', 'SSH command failed or timed out.'));
      };
      const timer = setTimeout(fail, this.commandTimeoutMs);
      signal?.addEventListener('abort', fail, { once: true });
      (client as NodeJS.EventEmitter).once('close',  fail);
      client.once('error', fail);
      stream.on('close', (code: number | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Number.isInteger(code) ? Number(code) : 1);
      });
      stream.on('error', fail);
      if (signal?.aborted) return fail();
      stream.resume();
      stream.stderr?.resume();
    });
  }

  async execText(client: Client, command: string, signal?: AbortSignal, maxBytes = 16 * 1024): Promise<string> {
    const stream = await this.execChannel(client, command, {}, signal);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', fail);
        (client as NodeJS.EventEmitter).removeListener('close',  fail);
        client.removeListener('error', fail);
      };
      const fail = (code: unknown = 'SSH_CONNECT_FAILED') => {
        if (settled) return;
        settled = true;
        cleanup();
        try { stream.close(); } catch (_) {}
        reject(terminalError(typeof code === 'string' ? code : 'SSH_CONNECT_FAILED', 'SSH command failed or timed out.'));
      };
      const timer = setTimeout(() => fail(), this.commandTimeoutMs);
      signal?.addEventListener('abort', fail, { once: true });
      (client as NodeJS.EventEmitter).once('close',  fail);
      client.once('error', fail);
      stream.on('data', (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.length;
        if (size > maxBytes) return fail('TMUX_INSPECTION_FAILED');
        chunks.push(value);
      });
      stream.once('error', fail);
      stream.once('close', (code: number | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code !== 0) return reject(terminalError('TMUX_INSPECTION_FAILED', 'Unable to inspect tmux session.'));
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      stream.stderr?.resume();
      if (signal?.aborted) return fail();
    });
  }

  async execInput(client: Client, command: string, input: string | Buffer, signal?: AbortSignal): Promise<void> {
    const stream = await this.execChannel(client, command, {}, signal);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', fail);
        (client as NodeJS.EventEmitter).removeListener('close',  fail);
        client.removeListener('error', fail);
        stream.removeListener('error', fail);
        stream.removeListener('exit', complete);
        stream.removeListener('close', complete);
      };
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code === 0) return resolve();
        reject(terminalError('TMUX_INPUT_FAILED', 'Unable to send input to tmux.'));
      };
      const complete = (code: number | null | undefined) => {
        if (!Number.isInteger(code)) return;
        finish(Number(code));
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { stream.close(); } catch (_) {}
        reject(terminalError('SSH_CONNECT_FAILED', 'SSH input command failed or timed out.'));
      };
      const timer = setTimeout(fail, this.commandTimeoutMs);
      signal?.addEventListener('abort', fail, { once: true });
      (client as NodeJS.EventEmitter).once('close',  fail);
      client.once('error', fail);
      stream.once('error', fail);
      stream.once('exit', complete);
      stream.once('close', complete);
      stream.resume();
      stream.stderr?.resume();
      if (signal?.aborted) return fail();
      try {
        stream.end(input);
      } catch (_) {
        fail();
      }
    });
  }

  async checkTmux(client: Client, sessionName: string, signal?: AbortSignal) {
    if (!TMUX_SESSION_RE.test(sessionName)) throw terminalError('INVALID_TMUX_SESSION', 'Invalid tmux session.');
    const available = await this.execStatus(client, 'tmux -V', signal);
    if (available !== 0) throw terminalError('TMUX_NOT_AVAILABLE', 'tmux is not available on the SSH host.');
    const exists = await this.execStatus(client, `tmux has-session -t '=${sessionName}'`, signal);
    if (exists !== 0) throw terminalError('TMUX_SESSION_NOT_FOUND', 'Configured tmux session was not found.');
  }

  async inspectTmux(client: Client, sessionName: string, signal?: AbortSignal): Promise<PaneInspection> {
    await this.checkTmux(client, sessionName, signal);
    const output = await this.execText(client,
      `tmux list-panes -t '=${sessionName}' -F '#{pane_id}\t#{pane_current_command}'`, signal);
    const panes = output.split(/\r?\n/).filter(Boolean).map((line: string) => {
      const tab = line.indexOf('\t');
      const id = tab === -1 ? line : line.slice(0, tab);
      const currentCommand = tab === -1 ? '' : line.slice(tab + 1);
      if (!/^%\d+$/.test(id)) throw terminalError('TMUX_INSPECTION_FAILED', 'tmux returned an invalid pane identifier.');
      return { id, current_command: currentCommand || null };
    });
    if (!panes.length) throw terminalError('TMUX_TARGET_MISSING', 'Configured tmux session has no target pane.');
    return {
      pane_count: panes.length,
      panes,
      target_pane: panes.length === 1 ? panes[0].id : null,
      pane_current_command: panes.length === 1 ? panes[0].current_command : null
    };
  }

  requireSinglePane(inspection: PaneInspection): string {
    if (!inspection?.target_pane) {
      throw terminalError('TMUX_MULTIPLE_PANES', 'MCP terminal control requires exactly one tmux pane in the configured session.');
    }
    return inspection.target_pane;
  }

  async captureText(connection: SshConnection, profile: SshProfile, lines: number, { signal, targetPane = null }: ReadOptions = {}): Promise<ReadCapture> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 10000) throw terminalError('INVALID_LINES', 'Invalid line count.');
    if (!TMUX_SESSION_RE.test(profile.tmux_session)) throw terminalError('INVALID_TMUX_SESSION', 'Invalid tmux session.');
    if (!connection?.client || signal?.aborted) throw terminalError('SSH_DISCONNECTED', 'Terminal disconnected.');
    const target = targetPane && /^%\d+$/.test(targetPane) ? targetPane : `=${profile.tmux_session}:`;
    const command = `tmux capture-pane -p -J -t '${target}' -S -`;
    return new Promise<ReadCapture>((resolve, reject) => {
      let stream: ClientChannel | undefined, done = false, tail = Buffer.alloc(0), truncated = false;
      const finish = (code: string | null) => {
        if (done) return; done = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        (connection.client as NodeJS.EventEmitter).removeListener('close', abort); connection.client.removeListener('error', abort);
        if (stream) { stream.removeListener('data', data); stream.removeListener('error', abort); stream.removeListener('close', closed); try { stream.close(); } catch (_) {} }
        if (code) return reject(terminalError(code, 'Unable to read tmux history.'));
        while (tail.length && (tail[0] & 0xc0) === 0x80) tail = tail.subarray(1);
        let text = tail.toString('utf8').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
          .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
          .replace(/\x1b[@-_]/g, '').replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
        const rows = text.split('\n'); if (rows.at(-1) === '') rows.pop();
        text = rows.slice(-lines).join('\n');
        resolve({ text, lines: Math.min(rows.length, lines), truncated });
      };
      const abort = () => finish('CAPTURE_FAILED');
      const closed = (code: number | undefined) => finish(code === 0 ? null : 'TMUX_TARGET_MISSING');
      const data = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const size = 2 * 1024 * 1024;
        if (tail.length + bytes.length > size) truncated = true;
        tail = Buffer.concat([tail, bytes]).subarray(-size);
      };
      const timer = setTimeout(abort, this.commandTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      (connection.client as NodeJS.EventEmitter).once('close', abort); connection.client.once('error', abort);
      try {
        connection.client.exec(command, {}, (error, channel) => {
          if (done) { try { channel?.close(); } catch (_) {} return; }
          if (error) return abort(); stream = channel;
          stream.on('data', data); stream.once('error', abort); stream.once('close', closed);
          stream.stderr?.resume();
        });
      } catch (_) { abort(); }
    });
  }

  async withVerifiedClient<T>(profile: SshProfile, password: string, operation: (client: Client) => Promise<T>, { signal }: AbortOptions = {}): Promise<T> {
    let client: Client | undefined;
    try {
      client = await this.connect(profile, password, { signal });
      await this.checkTmux(client, profile.tmux_session, signal);
      return await operation(client);
    } finally {
      if (client) client.end();
    }
  }

  async testConnection(profile: SshProfile, password: string, { signal }: AbortOptions = {}) {
    return this.withVerifiedClient(profile, password, async client => {
      const inspection = await this.inspectTmux(client, profile.tmux_session, signal);
      return { code: 'TEST_OK', ...inspection };
    }, { signal });
  }

  async inspectProfile(profile: SshProfile, password: string, { signal }: AbortOptions = {}) {
    return this.withVerifiedClient(profile, password,
      client => this.inspectTmux(client, profile.tmux_session, signal), { signal });
  }

  async sendText(profile: SshProfile, password: string, text: string, { submit = true, signal }: AbortOptions & {submit?: boolean} = {}) {
    if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > 64 * 1024) {
      throw terminalError('INVALID_INPUT', 'Terminal input must be between 1 byte and 64 KiB.');
    }
    if (typeof submit !== 'boolean') throw terminalError('INVALID_INPUT', 'Submit must be a boolean.');

    return this.withVerifiedClient(profile, password, async client => {
      const inspection = await this.inspectTmux(client, profile.tmux_session, signal);
      const target = this.requireSinglePane(inspection);
      const bufferName = `mcp-${crypto.randomBytes(8).toString('hex')}`;
      const paste = `tmux load-buffer -b '${bufferName}' - && tmux paste-buffer -b '${bufferName}' -t '${target}' -d`;
      const command = submit ? `${paste} && tmux send-keys -t '${target}' Enter` : paste;
      await this.execInput(client, command, text, signal);
      return { code: 'INPUT_SENT', target_pane: target, pane_current_command: inspection.pane_current_command };
    }, { signal });
  }

  async readText(profile: SshProfile, password: string, lines = 200, { signal }: AbortOptions = {}) {
    return this.withVerifiedClient(profile, password, async client => {
      const inspection = await this.inspectTmux(client, profile.tmux_session, signal);
      const target = this.requireSinglePane(inspection);
      const result = await this.captureText({ client }, profile, lines, { signal, targetPane: target });
      return { ...result, target_pane: target, pane_current_command: inspection.pane_current_command };
    }, { signal });
  }


  async sendInterrupt(profile: SshProfile, password: string, { signal }: AbortOptions = {}) {
    return this.withVerifiedClient(profile, password, async client => {
      const inspection = await this.inspectTmux(client, profile.tmux_session, signal);
      const target = this.requireSinglePane(inspection);
      const command = `tmux send-keys -t '${target}' C-c`;
      const status = await this.execStatus(client, command, signal);
      if (status !== 0) throw terminalError('TMUX_INTERRUPT_FAILED', 'Unable to send interrupt to tmux.');
      return { code: 'INTERRUPT_SENT', target_pane: target, pane_current_command: inspection.pane_current_command };
    }, { signal });
  }

  async execWorkspaceCommand(profile: SshProfile, password: string, command: string, { cwd = null, runAs = null, timeoutMs = 30000, maxOutputBytes = 1024 * 1024, signal }: CommandOptions = {}): Promise<CommandResult> {
    runAs = validateRunAs(runAs);
    const timeout = Math.min(Math.max(Number(timeoutMs) || 30000, 100), 300000);
    const start = Date.now();
    let client: Client | undefined;
    try {
      client = await this.connect(profile, password, { signal });
      const innerCommand = cwd ? `cd -- ${shellQuote(cwd)} && (${command}\n)` : `(${command}\n)`;
      const remoteShellCommand = runAs
        ? `sudo -n -u ${runAs} -- sh -lc ${shellQuote(innerCommand)}`
        : innerCommand;

      const stream = await this.execChannel(client, remoteShellCommand, {}, signal);
      return await new Promise<CommandResult>((resolve, reject) => {
        let settled = false;
        let exitCode: number | null = null;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutTruncated = false;
        let stderrTruncated = false;

        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          (client as NodeJS.EventEmitter).removeListener('close',  onFail);
          client?.removeListener('error', onFail);
        };

        const onTimeout = () => {
          if (settled) return;
          settled = true;
          cleanup();
          try { stream.close(); } catch (_) {}
          reject(terminalError('EXEC_TIMEOUT', `Command timed out after ${timeout}ms.`));
        };

        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          try { stream.close(); } catch (_) {}
          reject(terminalError('EXEC_ABORTED', 'Command execution was aborted.'));
        };

        const onFail = () => {
          if (settled) return;
          settled = true;
          cleanup();
          try { stream.close(); } catch (_) {}
          reject(terminalError('SSH_CONNECT_FAILED', 'SSH command channel failed or disconnected.'));
        };

        const timer = setTimeout(onTimeout, timeout);
        signal?.addEventListener('abort', onAbort, { once: true });
        (client as NodeJS.EventEmitter).once('close',  onFail);
        client?.once('error', onFail);

        stream.on('data', (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (stdoutBytes + buf.length > maxOutputBytes) {
            stdoutTruncated = true;
            const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
            if (remaining > 0) {
              stdoutChunks.push(buf.subarray(0, remaining));
              stdoutBytes += remaining;
            }
          } else {
            stdoutChunks.push(buf);
            stdoutBytes += buf.length;
          }
        });

        stream.stderr?.on('data', (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (stderrBytes + buf.length > maxOutputBytes) {
            stderrTruncated = true;
            const remaining = Math.max(0, maxOutputBytes - stderrBytes);
            if (remaining > 0) {
              stderrChunks.push(buf.subarray(0, remaining));
              stderrBytes += remaining;
            }
          } else {
            stderrChunks.push(buf);
            stderrBytes += buf.length;
          }
        });

        stream.once('exit', (code: number | undefined) => {
          if (Number.isInteger(code)) exitCode = Number(code);
        });

        stream.once('close', (code: number | undefined) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (exitCode === null && Number.isInteger(code)) exitCode = Number(code);
          const duration_ms = Date.now() - start;
          resolve({
            exit_code: exitCode ?? 0,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            duration_ms,
            stdout_truncated: stdoutTruncated,
            stderr_truncated: stderrTruncated
          });
        });

        stream.once('error', onFail);
        if (signal?.aborted) return onAbort();
      });
    } finally {
      if (client) {
        try { client.end(); } catch (_) {}
      }
    }
  }

  async inspectArtifactPath(client: Client, targetPath: string, signal?: AbortSignal, { runAs = null }: SshOptions = {}): Promise<{realTarget: string; fileSize: number}> {
    const escapedTarget = targetPath.replace(/'/g, "'\\''");
    const inspectScript = `target='${escapedTarget}'\n` +
      `real_target=$(realpath -e -- "$target" 2>/dev/null) || exit 2\n` +
      `[ -f "$real_target" ] || exit 3\n` +
      `size=$(stat -c %s -- "$real_target" 2>/dev/null) || exit 4\n` +
      `printf '%s\n%s\n' "$real_target" "$size"`;
    const inspectCommand = runAs
      ? `sudo -n -u ${runAs} -- sh -c ${shellQuote(inspectScript)}`
      : inspectScript;

    const stream = await this.execChannel(client, inspectCommand, {}, signal);
    return new Promise<{realTarget: string;fileSize: number}>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let exitCode: number | null = null;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', fail);
        (client as NodeJS.EventEmitter).removeListener('close',  fail);
        client.removeListener('error', fail);
      };
      const fail = (code: unknown = 'SSH_CONNECT_FAILED', msg = 'SSH inspection command failed or timed out.') => {
        if (settled) return;
        settled = true;
        cleanup();
        try { stream.close(); } catch (_) {}
        reject(terminalError(typeof code === 'string' ? code : 'SSH_CONNECT_FAILED', msg));
      };
      const timer = setTimeout(() => fail(), this.commandTimeoutMs);
      signal?.addEventListener('abort', fail, { once: true });
      (client as NodeJS.EventEmitter).once('close',  fail);
      client.once('error', fail);
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.stderr?.resume();
      stream.once('exit', (code: number | undefined) => {
        if (Number.isInteger(code)) exitCode = Number(code);
      });
      stream.once('close', (code: number | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (exitCode === null && Number.isInteger(code)) exitCode = Number(code);
        if (exitCode === 2) return reject(terminalError('ARTIFACT_NOT_FOUND', 'Artifact file not found.'));
        if (exitCode === 3) return reject(terminalError('NOT_A_REGULAR_FILE', 'Artifact path is not a regular file.'));
        if (exitCode !== 0) return reject(terminalError('ARTIFACT_INSPECTION_FAILED', `Failed to inspect artifact path (exit code ${exitCode}).`));
        const output = Buffer.concat(chunks).toString('utf8');
        const lines = output.split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) return reject(terminalError('ARTIFACT_INSPECTION_FAILED', 'Invalid artifact inspection response.'));
        resolve({ realTarget: lines[0].trim(), fileSize: Number(lines[1].trim()) });
      });
      if (signal?.aborted) return fail();
    });
  }

  async execBinary(client: Client, command: string, signal?: AbortSignal, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
    const stream = await this.execChannel(client, command, {}, signal);
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', fail);
        (client as NodeJS.EventEmitter).removeListener('close',  fail);
        client.removeListener('error', fail);
      };
      const fail = (code: unknown = 'SSH_CONNECT_FAILED', msg = 'SSH command failed or timed out.') => {
        if (settled) return;
        settled = true;
        cleanup();
        try { stream.close(); } catch (_) {}
        reject(terminalError(typeof code === 'string' ? code : 'SSH_CONNECT_FAILED', msg));
      };
      const timer = setTimeout(() => fail(), this.commandTimeoutMs);
      signal?.addEventListener('abort', fail, { once: true });
      (client as NodeJS.EventEmitter).once('close',  fail);
      client.once('error', fail);
      stream.on('data', (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.length;
        if (size > maxBytes) {
          return fail('ARTIFACT_TOO_LARGE', `Artifact content exceeds limit of ${maxBytes} bytes.`);
        }
        chunks.push(value);
      });
      stream.once('error', fail);
      stream.once('close', (code: number | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code !== 0) return reject(terminalError('ARTIFACT_READ_FAILED', 'Unable to read artifact file content.'));
        resolve(Buffer.concat(chunks));
      });
      stream.stderr?.resume();
      if (signal?.aborted) return fail();
    });
  }

  async collectArtifact(profile: SshProfile, password: string, requestedPath: string, { maxBytes = 2 * 1024 * 1024, runAs = null, signal }: FileOptions = {}) {
    runAs = validateRunAs(runAs);
    let client: Client | undefined;
    try {
      client = await this.connect(profile, password, { signal });
      const { realTarget, fileSize } = await this.inspectArtifactPath(client, requestedPath, signal, { runAs });

      // Validate file size boundary
      if (!Number.isFinite(fileSize) || fileSize < 0) {
        throw terminalError('ARTIFACT_INSPECTION_FAILED', 'Invalid artifact file size returned.');
      }
      if (fileSize > maxBytes) {
        throw terminalError('ARTIFACT_TOO_LARGE', `Artifact file size (${fileSize} bytes) exceeds maximum limit (${maxBytes} bytes).`);
      }

      // Stream file content safely
      const escapedRealTarget = realTarget.replace(/'/g, "'\\''");
      const readCommand = runAs ? `sudo -n -u ${runAs} -- cat -- '${escapedRealTarget}'` : `cat -- '${escapedRealTarget}'`;
      const fileBuffer = await this.execBinary(client, readCommand, signal, maxBytes);

      const filename = path.posix.basename(realTarget);
      const mimeType = mime.lookup(filename) || 'application/octet-stream';
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const isText = !fileBuffer.includes(0);
      const textContent = isText ? fileBuffer.toString('utf8') : null;

      return {
        filename,
        path: requestedPath,
        real_path: realTarget,
        size: fileBuffer.length,
        mime: mimeType,
        sha256,
        is_text: isText,
        text: textContent,
        limitations: {
          tool_file_reference_supported: false,
          direct_gdrive_upload_supported: false,
          reason: 'The MCP server can retrieve artifact bytes over SSH but cannot mint a ChatGPT-hosted tool file reference. Return metadata honestly; do not fabricate file_id/file_uri values.'
        }
      };
    } finally {
      if (client) {
        try { client.end(); } catch (_) {}
      }
    }
  }

  async execInputCommand(client: Client, command: string, input: Buffer | string, { signal, timeoutMs = 30000, maxStderrBytes = 64 * 1024 }: InputOptions = {}): Promise<{exit_code: number; stderr: string}> {
    const stream = await this.execChannel(client, command, {}, signal);
    const timeout = Math.min(Math.max(Number(timeoutMs) || 30000, 100), 300000);
    return new Promise<{exit_code: number;stderr: string}>((resolve, reject) => {
      let settled = false;
      let exitCode: number | null = null;
      let stderrBytes = 0;
      const stderrChunks: Buffer[] = [];
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        (client as NodeJS.EventEmitter).removeListener('close',  onFail);
        client.removeListener('error', onFail);
        stream.removeListener('error', onFail);
      };
      const finish = (code: number | null | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ exit_code: Number.isInteger(code) ? Number(code) : 1, stderr: Buffer.concat(stderrChunks).toString('utf8') });
      };
      const onFail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { stream.close(); } catch (_) {}
        reject(terminalError('SSH_CONNECT_FAILED', 'SSH input command failed or disconnected.'));
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { stream.close(); } catch (_) {}
        reject(terminalError('EXEC_ABORTED', 'SSH input command was aborted.'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try { stream.close(); } catch (_) {}
        reject(terminalError('EXEC_TIMEOUT', `SSH input command timed out after ${timeout}ms.`));
      }, timeout);
      signal?.addEventListener('abort', onAbort, { once: true });
      (client as NodeJS.EventEmitter).once('close',  onFail);
      client.once('error', onFail);
      stream.once('error', onFail);
      stream.stderr?.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = Math.max(0, maxStderrBytes - stderrBytes);
        if (remaining > 0) {
          stderrChunks.push(buf.subarray(0, remaining));
          stderrBytes += Math.min(buf.length, remaining);
        }
      });
      stream.once('exit', (code: number | undefined) => {
        if (!Number.isInteger(code)) return;
        exitCode = Number(code);
        // Some SSH servers emit an exit status but keep the channel open until
        // the client disconnects. Settle from the authoritative exit event so
        // successful stdin-driven writes do not report a false timeout.
        setImmediate(() => finish(code));
      });
      stream.once('close', (code: number | undefined) => finish(exitCode ?? code));
      stream.resume();
      if (signal?.aborted) return onAbort();
      try { stream.end(input); } catch (_) { onFail(); }
    });
  }

  async writeTextFile(profile: SshProfile, password: string, targetPath: string, content: string, { createDirs = false, runAs = null, signal }: WriteOptions = {}) {
    runAs = validateRunAs(runAs);
    let client: Client | undefined;
    try {
      client = await this.connect(profile, password, { signal });
      const token = crypto.randomBytes(8).toString('hex');
      const qTarget = shellQuote(targetPath);
      const mkdirLine = createDirs ? 'mkdir -p -- "$parent" || exit 41\n' : '[ -d "$parent" ] || exit 41\n';
      const command = `set -u\ntarget=${qTarget}\nparent=$(dirname -- "$target")\n${mkdirLine}` +
        `[ ! -e "$target" ] || [ -f "$target" ] || exit 42\n` +
        `tmp="${'$'}{target}.bot-report-${token}.tmp"\n` +
        `cleanup() { rm -f -- "$tmp"; }\ntrap cleanup EXIT HUP INT TERM\n` +
        `cat > "$tmp" || exit 43\n` +
        `if [ -e "$target" ]; then chmod --reference="$target" "$tmp" 2>/dev/null || true; chown --reference="$target" "$tmp" 2>/dev/null || true; fi\n` +
        `mv -f -- "$tmp" "$target" || exit 44\ntrap - EXIT HUP INT TERM\n`;
      const writeCommand = runAs ? `sudo -n -u ${runAs} -- sh -c ${shellQuote(command)}` : command;
      const result = await this.execInputCommand(client, writeCommand, Buffer.from(content, 'utf8'), { signal, timeoutMs: 30000 });
      if (result.exit_code === 41) throw terminalError('PARENT_NOT_FOUND', 'Parent directory does not exist.');
      if (result.exit_code === 42) throw terminalError('NOT_A_REGULAR_FILE', 'Target path exists and is not a regular file.');
      if (result.exit_code !== 0) throw terminalError('FILE_WRITE_FAILED', result.stderr || 'Unable to write file.');
      return { written: true };
    } finally {
      if (client) { try { client.end(); } catch (_) {} }
    }
  }

  async inspectManagedProcess(client: Client, processId: unknown, signal?: AbortSignal, lines = 200): Promise<ProcessSnapshot> {
    const id = validateManagedProcessId(processId);
    const exists = await this.execStatus(client, `tmux has-session -t ${shellQuote('=' + id)}`, signal);
    if (exists !== 0) throw terminalError('PROCESS_NOT_FOUND', 'Managed process was not found.');
    const target = `${id}:0.0`;
    const info = await this.execText(client,
      `tmux display-message -p -t ${shellQuote(target)} '#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}\t#{pane_current_command}'`,
      signal, 16 * 1024);
    const [deadRaw = '0', exitRaw = '', pidRaw = '', currentCommand = ''] = info.trim().split('\t');
    const rawOutput = await this.execText(client,
      `tmux capture-pane -p -J -t ${shellQuote(target)} -S -`, signal, 512 * 1024);
    const rows = rawOutput.replace(/\r\n/g, '\n').split('\n');
    while (rows.length && rows.at(-1)?.trim() === '') rows.pop();
    const selected = rows.slice(-Math.max(1, Math.min(Number(lines) || 200, 1000)));
    const dead = deadRaw === '1';
    return {
      process_id: id,
      state: dead ? 'EXITED' : 'RUNNING',
      exit_code: dead && /^-?\d+$/.test(exitRaw) ? Number(exitRaw) : null,
      pid: /^\d+$/.test(pidRaw) ? Number(pidRaw) : null,
      current_command: currentCommand || null,
      output: selected.join('\n'),
      output_lines: selected.length
    };
  }

  async startManagedProcess(profile: SshProfile, password: string, command: string, { cwd = null, runAs = null, signal }: ProcessOptions = {}) {
    runAs = validateRunAs(runAs);
    let client: Client | undefined;
    const processId = `brproc-${crypto.randomBytes(8).toString('hex')}`;
    try {
      client = await this.connect(profile, password, { signal });
      const tmuxAvailable = await this.execStatus(client, 'tmux -V', signal);
      if (tmuxAvailable !== 0) throw terminalError('TMUX_NOT_AVAILABLE', 'tmux is not available on the SSH host.');
      const target = `${processId}:0.0`;
      const logPath = managedProcessLogPath(processId);
      const logDir = path.posix.dirname(logPath);
      const innerCommand = cwd ? `cd -- ${shellQuote(cwd)} && exec sh -lc ${shellQuote(command)}` : `exec sh -lc ${shellQuote(command)}`;
      const processShell = runAs ? `exec sudo -n -u ${runAs} -- sh -lc ${shellQuote(innerCommand)}` : innerCommand;
      const pipeCommand = `cat >> ${shellQuote(logPath)}`;
      const launch = `mkdir -p -- ${shellQuote(logDir)} && chmod 700 -- ${shellQuote(logDir)} && : > ${shellQuote(logPath)} && ` +
        `tmux new-session -d -s ${shellQuote(processId)} ${shellQuote('sleep 86400')} && ` +
        `tmux set-option -t ${shellQuote(processId)} remain-on-exit on && ` +
        `tmux pipe-pane -O -t ${shellQuote(target)} ${shellQuote(pipeCommand)} && ` +
        `tmux respawn-pane -k -t ${shellQuote(target)} ${shellQuote(processShell)}`;
      const status = await this.execStatus(client, launch, signal);
      if (status !== 0) {
        try { await this.execStatus(client, `tmux kill-session -t ${shellQuote('=' + processId)}`, signal); } catch (_) {}
        try { await this.execStatus(client, `rm -f -- ${shellQuote(logPath)}`, signal); } catch (_) {}
        throw terminalError('PROCESS_START_FAILED', 'Unable to start managed process.');
      }
      return await this.inspectManagedProcess(client, processId, signal, 50);
    } finally {
      if (client) { try { client.end(); } catch (_) {} }
    }
  }

  async getManagedProcessStatus(profile: SshProfile, password: string, processId: unknown, { lines = 200, signal }: ProcessReadOptions = {}) {
    let client: Client | undefined;
    try {
      client = await this.connect(profile, password, { signal });
      return await this.inspectManagedProcess(client, processId, signal, lines);
    } finally {
      if (client) { try { client.end(); } catch (_) {} }
    }
  }

  async readManagedProcessLogs(profile: SshProfile, password: string, processId: unknown, { cursor = 0, maxBytes = 64 * 1024, signal }: ProcessLogOptions = {}) {
    const id = validateManagedProcessId(processId);
    const offset = Number(cursor);
    const limit = Number(maxBytes);
    if (!Number.isInteger(offset) || offset < 0) throw terminalError('INVALID_LOG_CURSOR', 'cursor must be a non-negative integer.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 512 * 1024) throw terminalError('INVALID_LOG_LIMIT', 'max_bytes must be between 1 and 524288.');
    const logPath = managedProcessLogPath(id);
    let client: Client | undefined;
    try {
      client = await this.connect(profile, password, { signal });
      const exists = await this.execStatus(client, `test -f ${shellQuote(logPath)}`, signal);
      if (exists !== 0) throw terminalError('PROCESS_LOG_NOT_FOUND', 'Managed process log was not found.');
      const sizeText = await this.execText(client, `stat -c %s -- ${shellQuote(logPath)}`, signal, 1024);
      const fileSize = Number(sizeText.trim());
      if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw terminalError('PROCESS_LOG_INVALID', 'Managed process log size is invalid.');
      if (offset > fileSize) throw terminalError('INVALID_LOG_CURSOR', 'cursor is beyond the current process log size.');
      const count = Math.min(limit, fileSize - offset);
      let buffer: Buffer = Buffer.alloc(0);
      if (count > 0) {
        buffer = await this.execBinary(client, `dd if=${shellQuote(logPath)} bs=1 skip=${offset} count=${count} status=none`, signal, count);
      }
      const nextCursor = offset + buffer.length;
      return {
        process_id: id,
        cursor: offset,
        next_cursor: nextCursor,
        log_size: fileSize,
        bytes: buffer.length,
        eof: nextCursor >= fileSize,
        text: sanitizeTerminalText(buffer.toString('utf8'))
      };
    } finally {
      if (client) { try { client.end(); } catch (_) {} }
    }
  }

  async stopManagedProcess(profile: SshProfile, password: string, processId: unknown, { force = true, graceMs = 1000, lines = 200, signal }: ProcessStopOptions = {}) {
    let client: Client | undefined;
    try {
      client = await this.connect(profile, password, { signal });
      const id = validateManagedProcessId(processId);
      let snapshot = await this.inspectManagedProcess(client, id, signal, lines);
      let forced = false;
      if (snapshot.state === 'RUNNING') {
        const target = `${id}:0.0`;
        const sent = await this.execStatus(client, `tmux send-keys -t ${shellQuote(target)} C-c`, signal);
        if (sent !== 0) throw terminalError('PROCESS_STOP_FAILED', 'Unable to interrupt managed process.');
        const deadline = Date.now() + Math.min(Math.max(Number(graceMs) || 1000, 100), 5000);
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
          snapshot = await this.inspectManagedProcess(client, id, signal, lines);
          if (snapshot.state === 'EXITED') break;
        }
        if (snapshot.state === 'RUNNING') {
          if (!force) throw terminalError('PROCESS_STOP_TIMEOUT', 'Managed process did not stop within the grace period.');
          forced = true;
        }
      }
      const finalSnapshot = snapshot;
      const killed = await this.execStatus(client, `tmux kill-session -t ${shellQuote('=' + id)}`, signal);
      if (killed !== 0) throw terminalError('PROCESS_STOP_FAILED', 'Unable to clean up managed process session.');
      const logPath = managedProcessLogPath(id);
      const logRemoved = await this.execStatus(client, `rm -f -- ${shellQuote(logPath)}`, signal);
      if (logRemoved !== 0) throw terminalError('PROCESS_STOP_FAILED', 'Managed process stopped but its temporary log could not be cleaned up.');
      return { ...finalSnapshot, state: 'STOPPED', forced, cleaned_up: true };
    } finally {
      if (client) { try { client.end(); } catch (_) {} }
    }
  }

  async openInteractive(profile: SshProfile, password: string, { cols = 80, rows = 24, onState = () => {}, signal }: InteractiveOptions = {}) {
    let client: Client | undefined;
    try {
      client = await this.connect(profile, password, { signal });
      onState('CHECKING_TMUX');
      await this.checkTmux(client, profile.tmux_session, signal);
      onState('ATTACHING');
      const stream = await this.execChannel(client, `tmux attach-session -t '=${profile.tmux_session}'`, {
        pty: { term: 'xterm-256color', cols, rows, width: 0, height: 0 }
      }, signal);
      return {
        client,
        stream,
        close() {
          try { stream.close(); } catch (_) {}
          try { client?.end(); } catch (_) {}
        }
      };
    } catch (error) {
      if (client) { try { client.end(); } catch (_) {} }
      throw error;
    }
  }
}

export = Object.assign(new TerminalSshService(), {TerminalSshService, terminalError});