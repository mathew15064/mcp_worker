#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const mime = require('mime-types');
const { buildCleanupPlan, applyCleanupPlan } = require('./lifecycle');

const DEFAULT_CAPABILITIES = Object.freeze([
  'tmux.inspect', 'tmux.send', 'tmux.read', 'tmux.interrupt',
  'workspace.exec', 'artifact.collect', 'file.write',
  'process.start', 'process.status', 'process.logs', 'process.stop'
]);

const serverUrl = String(process.env.BOT_REPORT_WORKER_SERVER_URL || '').replace(/\/+$/, '');
const statePath = path.resolve(process.env.BOT_REPORT_WORKER_STATE_PATH || path.join(os.homedir(), '.bot-report-worker', 'state.json'));
const workerName = String(process.env.BOT_REPORT_WORKER_NAME || os.hostname()).trim();
const enrollmentToken = String(process.env.BOT_REPORT_WORKER_ENROLLMENT_TOKEN || '').trim();
const allowShell = process.env.BOT_REPORT_WORKER_ALLOW_SHELL === 'true';
const allowInsecureHttp = process.env.BOT_REPORT_WORKER_ALLOW_INSECURE_HTTP === 'true';
const maxJobMs = Math.max(1_000, Math.min(Number(process.env.BOT_REPORT_WORKER_MAX_JOB_MS) || 300_000, 300_000));
const allowedRoots = String(process.env.BOT_REPORT_WORKER_ALLOWED_ROOTS || '')
  .split(',').map(value => value.trim()).filter(Boolean).map(value => path.resolve(value));

const managedProcesses = new Map();
let shuttingDown = false;
let reconnectAttempt = 0;
let heartbeatTimer = null;
let reconnectTimer = null;
let activeSocket = null;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireConfig() {
  let parsed;
  try { parsed = new URL(serverUrl); } catch (_) { throw fail('WORKER_SERVER_URL_REQUIRED', 'BOT_REPORT_WORKER_SERVER_URL must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw fail('WORKER_SERVER_URL_REQUIRED', 'BOT_REPORT_WORKER_SERVER_URL must use HTTP or HTTPS.');
  if (parsed.protocol !== 'https:' && !allowInsecureHttp) {
    throw fail('WORKER_TLS_REQUIRED', 'Worker server URL must use HTTPS. Set BOT_REPORT_WORKER_ALLOW_INSECURE_HTTP=true only for trusted local development.');
  }
  if (!workerName || workerName.length > 100) throw fail('WORKER_NAME_INVALID', 'BOT_REPORT_WORKER_NAME must be 1-100 characters.');
  if (!allowedRoots.length) throw fail('WORKER_ALLOWED_ROOTS_REQUIRED', 'BOT_REPORT_WORKER_ALLOWED_ROOTS must contain at least one local workspace root.');
}

function ensureStateDir() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function saveState(state) {
  ensureStateDir();
  const temp = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, statePath);
  try { fs.chmodSync(statePath, 0o600); } catch (_) {}
}

function generateIdentity() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function nearestExistingAncestor(target) {
  let current = target;
  while (true) {
    try { return fs.realpathSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function assertAllowedPath(input, { mustExist = false } = {}) {
  if (typeof input !== 'string' || !input.trim() || /[\x00-\x1f\x7f]/.test(input)) throw fail('WORKER_PATH_INVALID', 'Path is invalid.');
  const resolved = path.resolve(input);
  if (!allowedRoots.some(root => isWithinRoot(resolved, root))) throw fail('WORKER_PATH_DENIED', `Path '${resolved}' is outside worker allowed roots.`);
  let verified;
  try {
    verified = fs.realpathSync(resolved);
  } catch (error) {
    if (mustExist || error.code !== 'ENOENT') throw error;
    verified = nearestExistingAncestor(path.dirname(resolved));
  }
  if (!allowedRoots.some(root => isWithinRoot(verified, root))) throw fail('WORKER_PATH_DENIED', 'Resolved path escapes worker allowed roots.');
  return resolved;
}

function requireShell() {
  if (!allowShell) throw fail('WORKER_SHELL_DISABLED', 'Shell execution is disabled by local worker policy.');
}

function rejectRunAs(runAs) {
  if (runAs !== null && runAs !== undefined && runAs !== '') {
    throw fail('WORKER_RUN_AS_UNSUPPORTED', 'worker transport executes as the local worker OS user; run_as is not supported.');
  }
}

function boundedAppend(state, chunk, maxBytes) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, maxBytes - state.size);
  if (remaining > 0) state.chunks.push(value.subarray(0, remaining));
  state.size += value.length;
  if (state.size > maxBytes) state.truncated = true;
}

function runShell(command, { cwd, timeoutMs = 30_000, maxOutputBytes = 1024 * 1024 } = {}) {
  requireShell();
  const safeCwd = assertAllowedPath(cwd || allowedRoots[0], { mustExist: true });
  const timeout = Math.max(100, Math.min(Number(timeoutMs) || 30_000, maxJobMs));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-lc', command], { cwd: safeCwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = { chunks: [], size: 0, truncated: false };
    const stderr = { chunks: [], size: 0, truncated: false };
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch (_) {}
      settled = true;
      reject(fail('WORKER_JOB_TIMEOUT', 'Local worker command timed out.'));
    }, timeout);
    child.stdout.on('data', chunk => boundedAppend(stdout, chunk, maxOutputBytes));
    child.stderr.on('data', chunk => boundedAppend(stderr, chunk, maxOutputBytes));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: Number.isInteger(code) ? code : 1,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        duration_ms: Date.now() - started,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated
      });
    });
  });
}

function runFile(command, args, { input = null, cwd = null, timeoutMs = 10_000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: cwd || undefined, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = { chunks: [], size: 0, truncated: false };
    const stderr = { chunks: [], size: 0, truncated: false };
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch (_) {}
      settled = true;
      reject(fail('WORKER_COMMAND_TIMEOUT', `${command} timed out.`));
    }, Math.min(Math.max(Number(timeoutMs) || 10_000, 100), maxJobMs));
    child.stdout.on('data', chunk => boundedAppend(stdout, chunk, maxOutputBytes));
    child.stderr.on('data', chunk => boundedAppend(stderr, chunk, maxOutputBytes));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: Number.isInteger(code) ? code : 1, stdout: Buffer.concat(stdout.chunks), stderr: Buffer.concat(stderr.chunks) });
    });
    if (input !== null && input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function inspectTmux(session) {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(session || '')) throw fail('INVALID_TMUX_SESSION', 'Invalid tmux session.');
  const version = await runFile('tmux', ['-V']);
  if (version.code !== 0) throw fail('TMUX_NOT_AVAILABLE', 'tmux is not available on the worker host.');
  const exists = await runFile('tmux', ['has-session', '-t', `=${session}`]);
  if (exists.code !== 0) throw fail('TMUX_SESSION_NOT_FOUND', 'Configured tmux session was not found.');
  const list = await runFile('tmux', ['list-panes', '-t', `=${session}`, '-F', '#{pane_id}\t#{pane_current_command}']);
  if (list.code !== 0) throw fail('TMUX_INSPECTION_FAILED', 'Unable to inspect tmux session.');
  const panes = list.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const id = tab === -1 ? line : line.slice(0, tab);
    if (!/^%\d+$/.test(id)) throw fail('TMUX_INSPECTION_FAILED', 'tmux returned an invalid pane identifier.');
    return { id, current_command: tab === -1 ? null : (line.slice(tab + 1) || null) };
  });
  if (!panes.length) throw fail('TMUX_TARGET_MISSING', 'Configured tmux session has no target pane.');
  return {
    pane_count: panes.length,
    panes,
    target_pane: panes.length === 1 ? panes[0].id : null,
    pane_current_command: panes.length === 1 ? panes[0].current_command : null
  };
}

function singlePane(inspection) {
  if (!inspection.target_pane) throw fail('TMUX_MULTIPLE_PANES', 'Terminal control requires exactly one tmux pane.');
  return inspection.target_pane;
}

async function executeOperation(operation, payload = {}) {
  switch (operation) {
    case 'tmux.inspect':
      return inspectTmux(payload.tmux_session);
    case 'tmux.send': {
      const inspection = await inspectTmux(payload.tmux_session);
      const target = singlePane(inspection);
      const text = String(payload.text ?? '');
      if (!text || Buffer.byteLength(text, 'utf8') > 64 * 1024) throw fail('INVALID_INPUT', 'Terminal input must be 1 byte to 64 KiB.');
      const bufferName = `brw-${crypto.randomBytes(8).toString('hex')}`;
      let result = await runFile('tmux', ['load-buffer', '-b', bufferName, '-'], { input: text });
      if (result.code !== 0) throw fail('TMUX_INPUT_FAILED', 'Unable to load tmux input buffer.');
      result = await runFile('tmux', ['paste-buffer', '-b', bufferName, '-t', target, '-d']);
      if (result.code !== 0) throw fail('TMUX_INPUT_FAILED', 'Unable to paste tmux input.');
      if (payload.submit !== false) {
        result = await runFile('tmux', ['send-keys', '-t', target, 'Enter']);
        if (result.code !== 0) throw fail('TMUX_INPUT_FAILED', 'Unable to submit tmux input.');
      }
      return { code: 'INPUT_SENT', target_pane: target, pane_current_command: inspection.pane_current_command };
    }
    case 'tmux.read': {
      const inspection = await inspectTmux(payload.tmux_session);
      const target = singlePane(inspection);
      const lines = Math.max(1, Math.min(Number(payload.lines) || 200, 10_000));
      const result = await runFile('tmux', ['capture-pane', '-p', '-J', '-t', target, '-S', '-'], { maxOutputBytes: 2 * 1024 * 1024 });
      if (result.code !== 0) throw fail('CAPTURE_FAILED', 'Unable to read tmux history.');
      const rows = result.stdout.toString('utf8').replace(/\r\n/g, '\n').split('\n');
      if (rows.at(-1) === '') rows.pop();
      return { text: rows.slice(-lines).join('\n'), lines: Math.min(rows.length, lines), truncated: rows.length > lines, target_pane: target, pane_current_command: inspection.pane_current_command };
    }
    case 'tmux.interrupt': {
      const inspection = await inspectTmux(payload.tmux_session);
      const target = singlePane(inspection);
      const result = await runFile('tmux', ['send-keys', '-t', target, 'C-c']);
      if (result.code !== 0) throw fail('TMUX_INTERRUPT_FAILED', 'Unable to send interrupt to tmux.');
      return { code: 'INTERRUPT_SENT', target_pane: target, pane_current_command: inspection.pane_current_command };
    }
    case 'workspace.exec':
      rejectRunAs(payload.run_as);
      if (typeof payload.command !== 'string' || !payload.command.trim() || payload.command.length > 32_000 || payload.command.includes('\0')) throw fail('INVALID_COMMAND', 'Command is invalid.');
      return runShell(payload.command, { cwd: payload.cwd, timeoutMs: payload.timeout_ms, maxOutputBytes: payload.max_output_bytes });
    case 'artifact.collect': {
      rejectRunAs(payload.run_as);
      const target = assertAllowedPath(payload.path, { mustExist: true });
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw fail('ARTIFACT_NOT_FILE', 'Artifact path is not a regular file.');
      const maxBytes = Math.max(1, Math.min(Number(payload.max_bytes) || 2 * 1024 * 1024, 10 * 1024 * 1024));
      if (stat.size > maxBytes) throw fail('ARTIFACT_TOO_LARGE', `Artifact exceeds max_bytes (${stat.size} > ${maxBytes}).`);
      const bytes = fs.readFileSync(target);
      const type = mime.lookup(target) || 'application/octet-stream';
      const isText = /^text\//.test(type) || ['application/json', 'application/javascript', 'application/xml'].includes(type) || !bytes.includes(0);
      return {
        path: payload.path,
        real_path: fs.realpathSync(target),
        size: stat.size,
        mime_type: type,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        is_text: isText,
        text: isText ? bytes.toString('utf8') : null
      };
    }
    case 'file.write': {
      rejectRunAs(payload.run_as);
      const target = assertAllowedPath(payload.path, { mustExist: false });
      const content = String(payload.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw fail('FILE_TOO_LARGE', 'File content exceeds 2 MiB.');
      if (payload.create_dirs) fs.mkdirSync(path.dirname(target), { recursive: true });
      else assertAllowedPath(path.dirname(target), { mustExist: true });
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.brw-${crypto.randomBytes(6).toString('hex')}`);
      fs.writeFileSync(temp, content, 'utf8');
      fs.renameSync(temp, target);
      return { path: target };
    }
    case 'process.start': {
      rejectRunAs(payload.run_as);
      requireShell();
      const cwd = assertAllowedPath(payload.cwd || allowedRoots[0], { mustExist: true });
      const command = String(payload.command || '');
      if (!command.trim() || command.length > 32_000 || command.includes('\0')) throw fail('INVALID_COMMAND', 'Command is invalid.');
      const processId = `brproc-${crypto.randomBytes(8).toString('hex')}`;
      const logDir = path.join(os.tmpdir(), 'bot-report-worker-process');
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
      const logPath = path.join(logDir, `${processId}.log`);
      const logFd = fs.openSync(logPath, 'a', 0o600);
      const child = spawn('/bin/sh', ['-lc', command], { cwd, env: process.env, stdio: ['ignore', logFd, logFd], detached: false });
      const record = { process_id: processId, child, pid: child.pid, log_path: logPath, started_at: new Date().toISOString(), exited_at: null, exit_code: null, signal: null };
      managedProcesses.set(processId, record);
      child.once('close', (code, signal) => { record.exit_code = Number.isInteger(code) ? code : null; record.signal = signal || null; record.exited_at = new Date().toISOString(); try { fs.closeSync(logFd); } catch (_) {} });
      child.once('error', () => { record.exit_code = 1; record.exited_at = new Date().toISOString(); try { fs.closeSync(logFd); } catch (_) {} });
      return { process_id: processId, pid: child.pid, state: 'RUNNING', started_at: record.started_at };
    }
    case 'process.status': {
      const record = managedProcesses.get(String(payload.process_id || ''));
      if (!record) throw fail('PROCESS_NOT_FOUND', 'Managed process not found on this worker.');
      const text = fs.existsSync(record.log_path) ? fs.readFileSync(record.log_path, 'utf8') : '';
      const lines = Math.max(1, Math.min(Number(payload.lines) || 200, 1000));
      return { process_id: record.process_id, pid: record.pid, state: record.exited_at ? 'EXITED' : 'RUNNING', exit_code: record.exit_code, signal: record.signal, started_at: record.started_at, exited_at: record.exited_at, output_tail: text.split(/\r?\n/).slice(-lines).join('\n') };
    }
    case 'process.logs': {
      const record = managedProcesses.get(String(payload.process_id || ''));
      if (!record) throw fail('PROCESS_NOT_FOUND', 'Managed process not found on this worker.');
      const cursor = Math.max(0, Number(payload.cursor) || 0);
      const maxBytes = Math.max(1, Math.min(Number(payload.max_bytes) || 64 * 1024, 512 * 1024));
      const bytes = fs.existsSync(record.log_path) ? fs.readFileSync(record.log_path) : Buffer.alloc(0);
      const end = Math.min(bytes.length, cursor + maxBytes);
      return { process_id: record.process_id, cursor, next_cursor: end, text: bytes.subarray(cursor, end).toString('utf8'), eof: end >= bytes.length, truncated: end < bytes.length };
    }
    case 'process.stop': {
      const record = managedProcesses.get(String(payload.process_id || ''));
      if (!record) throw fail('PROCESS_NOT_FOUND', 'Managed process not found on this worker.');
      if (record.exited_at) return { ...(await executeOperation('process.status', { process_id: record.process_id, lines: payload.lines })), forced: false };
      const graceMs = Math.max(0, Math.min(Number(payload.grace_ms) || 1000, 30_000));
      try { record.child.kill('SIGTERM'); } catch (_) {}
      if (graceMs) await new Promise(resolve => setTimeout(resolve, graceMs));
      let forced = false;
      if (!record.exited_at && payload.force !== false) { forced = true; try { record.child.kill('SIGKILL'); } catch (_) {} }
      await new Promise(resolve => setTimeout(resolve, 20));
      return { ...(await executeOperation('process.status', { process_id: record.process_id, lines: payload.lines })), forced };
    }
    case 'worker.self_uninstall': {
      if (payload.confirm !== 'REMOVE_THIS_WORKER') {
        throw fail('WORKER_UNINSTALL_CONFIRMATION_REQUIRED', 'Remote uninstall requires the fixed REMOVE_THIS_WORKER confirmation.');
      }
      const plan = buildCleanupPlan({ runtimeDir: __dirname, workerHome: path.dirname(statePath) });
      return applyCleanupPlan(plan);
    }
    default:
      throw fail('WORKER_OPERATION_UNSUPPORTED', `Unsupported worker operation '${operation}'.`);
  }
}

async function enrollIfNeeded(state) {
  if (state?.worker_id && state?.private_key && state?.public_key) return state;
  if (!enrollmentToken) throw fail('WORKER_ENROLLMENT_TOKEN_REQUIRED', 'BOT_REPORT_WORKER_ENROLLMENT_TOKEN is required for first enrollment.');
  const identity = state?.private_key && state?.public_key ? state : generateIdentity();
  const response = await fetch(`${serverUrl}/worker/v1/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: enrollmentToken, name: workerName, public_key: identity.public_key, capabilities: DEFAULT_CAPABILITIES })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(payload.code || 'WORKER_ENROLLMENT_FAILED', payload.message || 'Worker enrollment failed.');
  const enrolled = { ...identity, worker_id: payload.worker_id, name: payload.name, server_url: serverUrl, enrolled_at: new Date().toISOString() };
  saveState(enrolled);
  return enrolled;
}

function connectionHeaders(state) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(24).toString('base64url');
  const message = `${state.worker_id}\n${timestamp}\n${nonce}\n/worker/v1/connect`;
  const signature = crypto.sign(null, Buffer.from(message, 'utf8'), state.private_key).toString('base64');
  return { 'x-br-worker-id': state.worker_id, 'x-br-worker-timestamp': timestamp, 'x-br-worker-nonce': nonce, 'x-br-worker-signature': signature };
}

function websocketUrl() {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/worker/v1/connect';
  url.search = '';
  return url.toString();
}

async function handleJob(ws, message) {
  const jobId = String(message.job_id || '');
  if (!jobId || typeof message.operation !== 'string') return;
  try {
    const result = await Promise.race([
      executeOperation(message.operation, message.payload || {}),
      new Promise((_, reject) => setTimeout(() => reject(fail('WORKER_JOB_TIMEOUT', 'Worker job exceeded local timeout.')), Math.min(Number(message.timeout_ms) || maxJobMs, maxJobMs)))
    ]);
    if (ws.readyState === WebSocket.OPEN) {
      const response = JSON.stringify({ type: 'result', job_id: jobId, ok: true, result });
      if (message.operation === 'worker.self_uninstall') ws.send(response, () => shutdown('REMOTE_UNINSTALL'));
      else ws.send(response);
    }
  } catch (error) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', job_id: jobId, ok: false, error: { code: error.code || 'WORKER_JOB_FAILED', message: error.message || 'Worker job failed.' } }));
  }
}

function scheduleReconnect(state) {
  if (shuttingDown) return;
  reconnectAttempt += 1;
  const delay = Math.min(30_000, 1000 * (2 ** Math.min(reconnectAttempt - 1, 5))) + Math.floor(Math.random() * 500);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(state), delay);
}

function connect(state) {
  if (shuttingDown) return;
  const ws = new WebSocket(websocketUrl(), { headers: connectionHeaders(state), maxPayload: 4 * 1024 * 1024 });
  activeSocket = ws;
  ws.on('open', () => {
    reconnectAttempt = 0;
    console.log(`[WORKER] connected worker_id=${state.worker_id} server=${serverUrl}`);
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() }));
    }, 20_000);
  });
  ws.on('message', data => {
    let message;
    try { message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch (_) { return; }
    if (message.type === 'job') handleJob(ws, message).catch(() => {});
  });
  ws.on('close', (code, reason) => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    const reasonText = String(reason || '');
    if (code === 4004 && reasonText === 'worker-removed') {
      shuttingDown = true;
      console.warn('[WORKER] identity removed by server; worker stopped.');
      return;
    }
    if (!shuttingDown) console.warn(`[WORKER] disconnected code=${code} reason=${reasonText}`);
    scheduleReconnect(state);
  });
  ws.on('error', error => {
    if (!shuttingDown) console.warn(`[WORKER] websocket error: ${error.message}`);
  });
}

async function main() {
  requireConfig();
  let state = loadState();
  state = await enrollIfNeeded(state);
  if (state.server_url && state.server_url !== serverUrl) {
    throw fail('WORKER_SERVER_MISMATCH', `Worker was enrolled against '${state.server_url}'. Remove the state file to enroll against a different server.`);
  }
  console.log(`[WORKER] starting name=${state.name || workerName} roots=${allowedRoots.join(',')} shell=${allowShell ? 'enabled' : 'disabled'}`);
  connect(state);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[WORKER] shutdown ${signal}`);
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  for (const record of managedProcesses.values()) {
    if (!record.exited_at) { try { record.child.kill('SIGTERM'); } catch (_) {} }
  }
  try { activeSocket?.close(1000, 'worker-shutdown'); } catch (_) {}
  setTimeout(() => process.exit(0), 50).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  main().catch(error => {
    console.error(`[WORKER_FATAL] ${error.code || error.name || 'ERROR'}: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { executeOperation, assertAllowedPath, generateIdentity, connectionHeaders, DEFAULT_CAPABILITIES };
