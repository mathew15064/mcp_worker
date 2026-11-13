/** Compile-time contract for the tool-facing terminal execution boundary.
 * The implementation is migrated in TS3.4; no wire fields change here. */
type Actor = { actorId?: string | null };
type RunAs = { runAs?: string | null };
type Data = Record<string, unknown>;
export interface TerminalToolService {
  list(options?: Actor): Promise<unknown[]>;
  workspaceExec(
    profile: string,
    command: string,
    options?: Actor & { cwd?: string | null; timeoutMs?: number },
  ): Promise<Data>;
  artifactCollect(
    profile: string,
    path: string,
    options?: Actor & { maxBytes?: number },
  ): Promise<Data>;
  fileRead(
    profile: string,
    path: string,
    options?: Actor &
      RunAs & { maxBytes?: number; startLine?: number | null; endLine?: number | null },
  ): Promise<Data>;
  fileWrite(
    profile: string,
    path: string,
    content: string,
    options?: Actor & RunAs & { createDirs?: boolean; expectedSha256?: string | null },
  ): Promise<Data>;
  filePatch(
    profile: string,
    path: string,
    oldText: string,
    newText: string,
    options?: Actor &
      RunAs & { expectedCount?: number; expectedSha256?: string | null; maxBytes?: number },
  ): Promise<Data>;
  processStart(
    profile: string,
    command: string,
    options?: Actor & RunAs & { cwd?: string | null },
  ): Promise<Data>;
  processStatus(
    profile: string,
    processId: string,
    options?: Actor & { lines?: number },
  ): Promise<Data>;
  processStop(
    profile: string,
    processId: string,
    options?: Actor & { force?: boolean; graceMs?: number; lines?: number },
  ): Promise<Data>;
  processLogs(
    profile: string,
    processId: string,
    options?: Actor & { cursor?: number; maxBytes?: number },
  ): Promise<Data>;
  repoSnapshot(
    profile: string,
    repo: string,
    options?: Actor & RunAs & { base?: string | null },
  ): Promise<Data>;
  gitDiff(
    profile: string,
    repo: string,
    options?: Actor &
      RunAs & { base?: string; paths?: string[]; contextLines?: number; maxDiffBytes?: number },
  ): Promise<Data>;
  codeSearch(
    profile: string,
    cwd: string,
    query: string,
    options?: Actor &
      RunAs & {
        glob?: string | null;
        regex?: boolean;
        caseSensitive?: boolean;
        hidden?: boolean;
        maxResults?: number;
      },
  ): Promise<Data>;
  checkRun(
    profile: string,
    command: string,
    options?: Actor & RunAs & { cwd?: string | null; timeoutMs?: number; tailLines?: number },
  ): Promise<Data>;
}
