# MCP Gateway performance review (2026-11-20)

Scope: `mcp_worker` 3.0.0, SQLite-only, 15 MCP tools, HTTP Streamable MCP
and persistent outbound WSS Go Worker transport. No storage, protocol, OAuth
scope, Worker identity, or tool wire-schema migrations.

## Reproduce on a development checkout

```sh
MCP_BENCH_N=130 npm run benchmark:mcp
```

The script builds the current checkout, creates an isolated disposable SQLite
database, issues a real OAuth access token, serves the Express application on
loopback, and performs authenticated `POST /mcp` calls. It collects 130
sequential calls each to `tools/list` and `runtime_info`, then 128
`tools/list` calls in batches of eight. Twelve warmup calls precede each
sequential series. No production/remote OAuth tokens or Worker commands are
used. The script cleans up the disposable database on completion.

The script additionally profiles OAuth token verification and MCP Server setup
**in process**, separately from HTTP requests. These are microbenchmarks and
must not be presented as end-to-end latency.

## Initial baseline versus updated development source

Single local run per snapshot, same checkout host, Node 22, 130 sequential
calls per operation. Results are indicative, not an SLA or statistically
robust performance claim.

| Operation | Before p50 | After p50 | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| `tools/list`, sequential | 3.26 ms | 2.96 ms | 5.04 ms | 4.45 ms |
| `runtime_info`, sequential | 5.09 ms | 2.60 ms | 7.47 ms | 4.48 ms |
| `tools/list`, concurrency 8 | 19.54 ms | 17.20 ms | 31.35 ms | 29.45 ms |

The largest demonstrated improvement is `runtime_info` (about 40% lower
p95 in this local comparison). Both `tools/list` and concurrent latency
vary between runs; their smaller differences should not be overinterpreted.
Use multiple repetitions under a stable workload before any performance SLA
or production claim.

### Gateway observations and changes

- `runtime_info` previously walked/read/hashed the full source tree and
  recomputed tool schema hashes on **every call**. These values now remain
  stable for the lifetime of the process and are calculated once, lazily.
  Restart a deployed build to obtain the fingerprint of a new build.
- OAuth validates the access token, client, owner, resource and revocation
  against SQLite **on every request**. Only `last_used_at` bookkeeping writes
  are coalesced to approximately one per minute per active token. The
  timestamp is now up to about 60 seconds stale by design; it is not used as
  an authorization or revocation check.
- `tools/list` schema caching already exists and is retained. MCP Server
  and Streamable HTTP transport instances remain request-scoped for
  correctness and client isolation.
- Independent in-process measurements after the change: OAuth verification
  p95 ~0.08 ms; MCP Server creation p95 ~0.23 ms. No evidence justifies
  replacing the SDK request lifecycle.
- A simulated in-process broker test, with no network or shell, measured
  p95 ~0.027 ms sequential and ~0.112 ms at concurrency 8. These are **not**
  real Worker execution timings; live Worker authorization and WSS transport
  remain unchanged, including fail-closed database checks and no automatic
  replay after uncertain outcomes.

## Tool workflow

The published MCP tool catalog remains unchanged. When a Worker UUID is
already known, reuse that immutable target instead of calling
`terminal_list` before every operation. Continue to use bounded
`file_read`, `code_search` and `git_diff`, and prefer the dedicated tools
over unrelated broad `workspace_exec` calls. Parallelize independent reads,
not dependent file edits, Git pushes, releases or deploys.

## Verification and unmeasured work

- Build and TypeScript typecheck: PASS.
- Focused OAuth, HTTP MCP, catalog, Worker, and signed loopback WSS suites:
  36/36 tests passed.
- OAuth tests explicitly check live revocation and `last_used_at` refresh
  after the one-minute interval.
- The review changes no UI, so browser visual tests are not required.
- **Not measured:** real remote Go Worker end-to-end latency split into
  network, process launch and command runtime; ChatGPT client-side latency;
  high-scale SQLite contention under a multi-user production workload.
  Do not infer these gains from the loopback microbenchmarks.

No UDP/QUIC, Redis, alternate database, new service, or automatic retry
mechanism is recommended without a measured bottleneck. Collect live p50/p95,
CPU/RAM and failure-rate evidence on a separately approved release before
claiming end-to-end production speed gains.
