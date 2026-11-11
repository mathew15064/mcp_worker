import workerConnectionBroker from './workerConnectionBroker';
import type { ExecutionDispatchPort } from '../deployment/ports';
import type {
  ExecutionRecord,
  ShellInspection,
  ShellInputResult,
  ShellOutput,
  WorkspaceResult,
  ArtifactResult,
  ProcessStartResult,
  ProcessStatusResult,
  ProcessStopResult,
  ProcessLogResult,
} from './executionContracts';
interface WorkerProfileRef {
  id?: string | null;
  worker_id?: string | null;
}
type Profile = WorkerProfileRef | null | undefined;
type Broker = ExecutionDispatchPort;
interface ExecOptions {
  cwd?: string | null;
  runAs?: string | null;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
interface ArtifactOptions {
  maxBytes?: number;
  runAs?: string | null;
}
interface WriteOptions {
  createDirs?: boolean;
  runAs?: string | null;
}
interface StartOptions {
  cwd?: string | null;
  runAs?: string | null;
}
interface LogsOptions {
  cursor?: number;
  maxBytes?: number;
}
interface StopOptions {
  force?: boolean;
  graceMs?: number;
  lines?: number;
}

function workerExecutionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

class WorkerExecutionService {
  broker: Broker;
  constructor({ broker = workerConnectionBroker }: { broker?: Broker } = {}) {
    this.broker = broker;
  }

  workerId(profile: Profile) {
    if (!profile?.worker_id)
      throw workerExecutionError(
        'WORKER_PROFILE_INVALID',
        'Worker profile has no worker identity.',
      );
    return profile.worker_id;
  }

  async testConnection(profile: Profile) {
    const inspection = await this.inspectProfile(profile);
    return { code: 'TEST_OK', ...inspection };
  }

  shellKey(profile: Profile) {
    if (!profile?.id)
      throw workerExecutionError(
        'WORKER_PROFILE_INVALID',
        'Worker profile has no profile identity.',
      );
    return `profile:${profile.id}`;
  }

  inspectProfile(profile: Profile) {
    return this.broker.dispatch<ShellInspection>(
      this.workerId(profile),
      'shell.inspect',
      {
        session_key: this.shellKey(profile),
      },
      { timeoutMs: 10_000 },
    );
  }

  sendText(
    profile: Profile,
    _password: unknown,
    text: string,
    { submit = true }: { submit?: boolean } = {},
  ) {
    return this.broker.dispatch<ShellInputResult>(
      this.workerId(profile),
      'shell.send',
      {
        session_key: this.shellKey(profile),
        text,
        submit,
      },
      { timeoutMs: 10_000 },
    );
  }

  readText(profile: Profile, _password: unknown, lines = 200) {
    return this.broker.dispatch<ShellOutput>(
      this.workerId(profile),
      'shell.read',
      {
        session_key: this.shellKey(profile),
        lines,
      },
      { timeoutMs: 10_000 },
    );
  }

  sendInterrupt(profile: Profile) {
    return this.broker.dispatch<ShellInputResult>(
      this.workerId(profile),
      'shell.interrupt',
      {
        session_key: this.shellKey(profile),
      },
      { timeoutMs: 10_000 },
    );
  }

  execWorkspaceCommand(
    profile: Profile,
    _password: unknown,
    command: string,
    {
      cwd = null,
      runAs = null,
      timeoutMs = 30_000,
      maxOutputBytes = 1024 * 1024,
    }: ExecOptions = {},
  ) {
    return this.broker.dispatch<WorkspaceResult>(
      this.workerId(profile),
      'workspace.exec',
      {
        command,
        cwd,
        run_as: runAs,
        timeout_ms: timeoutMs,
        max_output_bytes: maxOutputBytes,
      },
      { timeoutMs },
    );
  }

  collectArtifact(
    profile: Profile,
    _password: unknown,
    artifactPath: string,
    { maxBytes = 2 * 1024 * 1024, runAs = null }: ArtifactOptions = {},
  ) {
    return this.broker.dispatch<ArtifactResult>(
      this.workerId(profile),
      'artifact.collect',
      {
        path: artifactPath,
        max_bytes: maxBytes,
        run_as: runAs,
      },
      { timeoutMs: 30_000 },
    );
  }

  writeTextFile(
    profile: Profile,
    _password: unknown,
    filePath: string,
    content: string,
    { createDirs = false, runAs = null }: WriteOptions = {},
  ) {
    return this.broker.dispatch<ExecutionRecord>(
      this.workerId(profile),
      'file.write',
      {
        path: filePath,
        content,
        create_dirs: Boolean(createDirs),
        run_as: runAs,
      },
      { timeoutMs: 30_000 },
    );
  }

  startManagedProcess(
    profile: Profile,
    _password: unknown,
    command: string,
    { cwd = null, runAs = null }: StartOptions = {},
  ) {
    return this.broker.dispatch<ProcessStartResult>(
      this.workerId(profile),
      'process.start',
      {
        command,
        cwd,
        run_as: runAs,
      },
      { timeoutMs: 30_000 },
    );
  }

  getManagedProcessStatus(
    profile: Profile,
    _password: unknown,
    processId: string,
    { lines = 200 }: { lines?: number } = {},
  ) {
    return this.broker.dispatch<ProcessStatusResult>(
      this.workerId(profile),
      'process.status',
      {
        process_id: processId,
        lines,
      },
      { timeoutMs: 10_000 },
    );
  }

  readManagedProcessLogs(
    profile: Profile,
    _password: unknown,
    processId: string,
    { cursor = 0, maxBytes = 64 * 1024 }: LogsOptions = {},
  ) {
    return this.broker.dispatch<ProcessLogResult>(
      this.workerId(profile),
      'process.logs',
      {
        process_id: processId,
        cursor,
        max_bytes: maxBytes,
      },
      { timeoutMs: 10_000 },
    );
  }

  stopManagedProcess(
    profile: Profile,
    _password: unknown,
    processId: string,
    { force = true, graceMs = 1000, lines = 200 }: StopOptions = {},
  ) {
    return this.broker.dispatch<ProcessStopResult>(
      this.workerId(profile),
      'process.stop',
      {
        process_id: processId,
        force,
        grace_ms: graceMs,
        lines,
      },
      { timeoutMs: Math.min(30_000, Math.max(10_000, Number(graceMs) + 5_000)) },
    );
  }
}

const instance = Object.assign(new WorkerExecutionService(), {
  WorkerExecutionService,
  workerExecutionError,
});
export = instance;
