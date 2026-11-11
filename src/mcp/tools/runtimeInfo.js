const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assertPrincipal } = require('../context');
const { SCOPES } = require('../../auth/principal');
const packageJson = require('../../../package.json');

const PROCESS_STARTED_AT = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function collectSourceFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function sourceFingerprint() {
  const files = [path.join(PROJECT_ROOT, 'package.json'), ...collectSourceFiles(path.join(PROJECT_ROOT, 'src'))];
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(PROJECT_ROOT, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function schemaFingerprint(tools) {
  const normalized = tools
    .map(tool => ({
      name: tool.name,
      description: tool.description || null,
      domain: tool.domain || null,
      required_scope: tool.requiredScope || null,
      annotations: tool.annotations || null,
      fields: Object.entries(tool.schema || {})
        .map(([name, schema]) => ({
          name,
          type: schema?.constructor?.name || null,
          description: schema?.description || null
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return sha256(JSON.stringify(normalized));
}

async function handleRuntimeInfo() {
  const principal = assertPrincipal();
  principal.assertScope(SCOPES.READ);
  const { TOOLS } = require('../toolRegistry');
  const value = {
    app_name: packageJson.name,
    app_version: packageJson.version,
    git_sha: process.env.BOT_REPORT_GIT_SHA && process.env.BOT_REPORT_GIT_SHA !== 'unknown' ? process.env.BOT_REPORT_GIT_SHA : null,
    build_time: process.env.BOT_REPORT_BUILD_TIME && process.env.BOT_REPORT_BUILD_TIME !== 'unknown' ? process.env.BOT_REPORT_BUILD_TIME : null,
    source_fingerprint: sourceFingerprint(),
    tool_schema_hash: schemaFingerprint(TOOLS),
    tool_count: TOOLS.length,
    started_at: PROCESS_STARTED_AT,
    runtime_id: os.hostname(),
    pid: process.pid,
    node_version: process.version,
    node_env: process.env.NODE_ENV || null
  };
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  };
}

module.exports = {
  name: 'runtime_info',
  description: 'Return sanitized mcp_worker runtime/build identity, tool schema hash, and a fingerprint over package.json plus the complete MCP-only src tree. Use first after deploy, rebuild, or MCP refresh when you need to verify which version is actually running.',
  schema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  handler: handleRuntimeInfo,
  _test: { sourceFingerprint, schemaFingerprint, collectSourceFiles }
};
