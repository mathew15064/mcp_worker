/** Contracts for Worker-only execution through the authenticated outbound WSS broker.
 * Historical SSH database tables remain for nondestructive migration, but no
 * application code connects to SSH or accepts SSH credentials.
 */
export interface ExecutionProfile {
  id: string;
  name: string;
  description?: string | null;
  transport: 'worker';
  enabled: boolean;
  worker_id?: string | null;
}
export type ExecutionRecord = Record<string, unknown>;
export type ShellInspection = ExecutionRecord & {
  pane_count: number;
  target_pane?: string;
  pane_current_command?: string;
  panes?: unknown[];
};
export type ShellOutput = ExecutionRecord & { text: string };
export type ShellInputResult = ExecutionRecord & {
  target_pane?: string;
  pane_current_command?: string;
};
export type WorkspaceResult = ExecutionRecord & {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
};
export type ArtifactResult = ExecutionRecord & {
  is_text: boolean;
  text?: string;
  real_path: string;
  sha256: string;
  size: number;
};
export type ProcessStartResult = ExecutionRecord & { process_id: string };
export type ProcessStatusResult = ExecutionRecord & { state: string };
export type ProcessStopResult = ExecutionRecord & { forced: boolean };
export type ProcessLogResult = ExecutionRecord & { eof: boolean };
export interface ExecutionTransport {
  inspectProfile(profile: ExecutionProfile, password?: string | null): Promise<ShellInspection>;
  sendText(
    profile: ExecutionProfile,
    password: string | null,
    text: string,
    options?: { submit?: boolean },
  ): Promise<ShellInputResult>;
  readText(
    profile: ExecutionProfile,
    password: string | null,
    lines?: number,
  ): Promise<ShellOutput>;
  sendInterrupt(profile: ExecutionProfile, password?: string | null): Promise<ShellInputResult>;
  execWorkspaceCommand(
    profile: ExecutionProfile,
    password: string | null,
    command: string,
    options?: {
      cwd?: string | null;
      runAs?: string | null;
      timeoutMs?: number;
      maxOutputBytes?: number;
    },
  ): Promise<WorkspaceResult>;
  collectArtifact(
    profile: ExecutionProfile,
    password: string | null,
    path: string,
    options?: { maxBytes?: number; runAs?: string | null },
  ): Promise<ArtifactResult>;
  writeTextFile(
    profile: ExecutionProfile,
    password: string | null,
    path: string,
    content: string,
    options?: {
      createDirs?: boolean;
      runAs?: string | null;
    },
  ): Promise<ExecutionRecord>;
  startManagedProcess(
    profile: ExecutionProfile,
    password: string | null,
    command: string,
    options?: {
      cwd?: string | null;
      runAs?: string | null;
    },
  ): Promise<ProcessStartResult>;
  getManagedProcessStatus(
    profile: ExecutionProfile,
    password: string | null,
    processId: string,
    options?: { lines?: number },
  ): Promise<ProcessStatusResult>;
  readManagedProcessLogs(
    profile: ExecutionProfile,
    password: string | null,
    processId: string,
    options?: {
      cursor?: number;
      maxBytes?: number;
    },
  ): Promise<ProcessLogResult>;
  stopManagedProcess(
    profile: ExecutionProfile,
    password: string | null,
    processId: string,
    options?: {
      force?: boolean;
      graceMs?: number;
      lines?: number;
    },
  ): Promise<ProcessStopResult>;
}
