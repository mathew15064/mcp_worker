# Local Coding Harness

mcp_worker is intentionally a small MCP execution layer. ChatGPT performs reasoning; mcp_worker provides deterministic primitives over stable execution profile aliases.

```text
Preferred v2 path:
Owner -> ChatGPT -> mcp_worker -> Worker Profile -> outbound WSS -> local worker

Compatibility path:
Owner -> ChatGPT -> mcp_worker -> SSH Profile -> SSH -> local machine
```

The 19 MCP tool names stay transport-neutral. The selected profile alias determines whether the operation is executed by the outbound worker transport or the legacy SSH compatibility transport.

## Tool-selection contract

MCP `initialize` publishes server instructions. The preferred order is:

```text
runtime_info
-> repo_snapshot
-> git_diff / code_search
-> file_read
-> file_patch / file_write
-> check_run
-> process_start / process_logs / process_status / process_stop
-> artifact_collect
```

`workspace_exec` is the generic one-shot fallback when no structured primitive fits. `terminal_*` is reserved for interactive tmux coordination.

## Runtime identity

`runtime_info` returns app version, optional build Git SHA/time, process start time, runtime ID, tool count, tool schema hash, and a fingerprint over the MCP execution surface. This is the first check after deploy/rebuild/connector refresh when runtime provenance matters.

## File primitives

- `file_read`: UTF-8 read with optional line ranges, size, and SHA-256.
- `file_write`: atomic new/full-file write; optional `expected_sha256` overwrite guard.
- `file_patch`: exact text replacement with `expected_count` and optional `expected_sha256` from a prior read.

Use bounded reads and pass the prior SHA whenever possible. If another process changes the file before patching, the operation fails with `FILE_CHANGED` rather than writing against stale state.

## Repository/review primitives

- `repo_snapshot`: branch, HEAD, upstream, dirty state, ahead/behind, changed files, optional merge-base.
- `git_diff`: bounded structured diff plus file statistics.
- `code_search`: bounded exact/regex `ripgrep` matches.
- `check_run`: finite test/lint/typecheck/formatter/build execution with compact pass/fail context.

These are wrappers around existing host tools. There is no semantic index, vector database, hidden agent orchestration, or secondary reasoning layer inside mcp_worker.

## Managed processes

Use managed processes for servers, watchers, workers, or E2E support commands that outlive one MCP call:

```text
process_start -> process_logs(cursor) / process_status -> process_stop
```

Each process runs in a dedicated `brproc-*` tmux session. Cursor-based logs avoid repeatedly returning old output. `process_stop` cleans the tmux session and temporary process log.

## Execution Profile boundary

MCP calls receive only a profile alias. Transport-specific credentials are never part of MCP tool input schemas.

For **Worker Profiles**, the target machine initiates an outbound authenticated WSS connection. The worker private key remains local, no SSH password is stored by mcp_worker, and effective machine access is the OS user running the worker plus any permissions explicitly granted on that host. Worker allowed roots constrain path-bearing operations, but shell execution is not a filesystem sandbox.

For **SSH Profiles**, raw host/user/password are still hidden from MCP callers and the stored password remains AES-256-GCM encrypted. Effective machine access is the configured SSH user's permissions plus any explicit `sudo -n` permissions granted by the host.

## Evidence

`artifact_collect` returns verified path/size/MIME/SHA-256 metadata and text when applicable. It never fabricates external connector file IDs. Binary upload to another service requires a real file handoff mechanism from the host/client.

## Completion rule

A successful tool call proves only that an operation executed. Before claiming a coding task complete, inspect the resulting diff and run the relevant checks/evidence path.
