'use strict';

// Isolated, authenticated loopback benchmark. Never opens the VPS database.
const http = require('node:http');
const helper = require('../dist/tests/helper.js');

const { setupEnv, initDb, issueToken, cleanup, parseMcpResponse } = helper;
const count = Math.max(20, Math.min(2000, Number(process.env.MCP_BENCH_N) || 130));
const concurrency = 8;
const samples = {};
const fixture = setupEnv('mcp_worker_perf');
initDb();
const app = require('../dist/src/app.js');

function summary(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  return {
    count: n,
    p50_ms: +sorted[Math.floor((n - 1) * 0.5)].toFixed(2),
    p95_ms: +sorted[Math.floor((n - 1) * 0.95)].toFixed(2),
    mean_ms: +(sorted.reduce((sum, value) => sum + value, 0) / n).toFixed(2),
  };
}

async function main() {
  const server = http.createServer(app);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/mcp';
    const credentials = await issueToken({ principalId: 'principal:benchmark' });
    let nextId = 0;

    async function rpc(method, params) {
      const started = process.hrtime.bigint();
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer ' + credentials.token.access_token,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
      });
      const body = await parseMcpResponse(response);
      if (response.status !== 200 || body.error || body.result?.isError) {
        throw new Error('MCP benchmark failed: ' + method + ' HTTP ' + response.status);
      }
      return Number(process.hrtime.bigint() - started) / 1e6;
    }

    for (const [label, method, params] of [
      ['tools_list', 'tools/list', {}],
      ['runtime_info', 'tools/call', { name: 'runtime_info', arguments: {} }],
    ]) {
      for (let i = 0; i < 12; i++) await rpc(method, params);
      const timings = [];
      for (let i = 0; i < count; i++) timings.push(await rpc(method, params));
      samples[label] = summary(timings);
    }

    const timings = [];
    for (let batch = 0; batch < Math.floor(count / concurrency); batch++) {
      timings.push(
        ...(await Promise.all(
          Array.from({ length: concurrency }, () => rpc('tools/list', {})),
        )),
      );
    }
    samples.tools_list_8_concurrent = summary(timings);

    // Isolate two Gateway costs without network, TLS, or MCP response parsing.
    // These are in-process microbenchmarks, not end-to-end latency.
    const resourceServer = require('../dist/src/auth/oauthResourceServer.js');
    const authSamples = [];
    for (let i = 0; i < count; i++) {
      const started = process.hrtime.bigint();
      await resourceServer.verifyToken(credentials.token.access_token);
      authSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.oauth_verify_in_process = summary(authSamples);

    const { createMcpServer } = require('../dist/src/mcp/server.js');
    const setupSamples = [];
    for (let i = 0; i < count; i++) {
      const started = process.hrtime.bigint();
      createMcpServer();
      setupSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.mcp_server_setup_in_process = summary(setupSamples);
    console.log(JSON.stringify({ iterations: count, samples }, null, 2));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    cleanup(fixture.dir);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
