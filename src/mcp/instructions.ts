export const SERVER_INSTRUCTIONS = `mcp_worker is a deterministic MCP-only local development execution harness.

Preferred workflow:
1. Use runtime_info first after deploy/rebuild/refresh when runtime identity matters.
2. Use repo_snapshot near the start of a repository task.
3. Use git_diff for bounded pre/post-change review.
4. Use code_search before broad file reads when the relevant location is unknown.
5. Use file_read before editing an existing file and keep reads bounded by line range when possible.
6. Prefer file_patch for localized edits and pass file_read.sha256 as expected_sha256 whenever available. Use file_write for new files or intentional full-file replacement.
7. Use check_run for finite test/lint/typecheck/formatter/build commands.
8. Use process_start/process_logs/process_status/process_stop for long-running servers, watchers, workers, or E2E support processes.
9. Use artifact_collect for verification evidence.
10. Use workspace_exec only as the generic fallback when no specialized structured tool fits.
11. Use terminal_list to discover enrolled Worker execution target aliases. MCP commands run through outbound Worker WSS; direct SSH is not supported.

Verification rules:
- Tool success proves only that an operation completed; it does not prove task correctness.
- Review the resulting diff and run relevant checks before claiming implementation is complete.
- Keep execution deterministic and bounded. Do not invent file references, credentials, deployment state, or test results.`;
