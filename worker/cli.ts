#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import {spawn, spawnSync} from 'node:child_process';
import {stdin, stdout} from 'node:process';
import agent = require('./agent');
const {DEFAULT_CAPABILITIES} = agent;
import lifecycle = require('./lifecycle');
const {buildCleanupPlan, applyCleanupPlan} = lifecycle;

interface WorkerConfig {server_url: string; worker_name: string; profile_name: string; tmux_session: string; tmux_created_by_worker: boolean; allowed_roots: string[]; allow_shell: boolean; allow_insecure_http: boolean; max_job_ms: number; updated_at: string}
interface WorkerState {worker_id?: string; private_key?: string; public_key?: string; name?: string; server_url?: string; enrolled_at?: string}
interface CliOptions { [key: string]: string | boolean | undefined; server?: string; token?: string; roots?: string; name?: string; profile?: string; tmux?: string}
function errorCode(error: unknown): string | undefined {return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined}
function errorMessage(error: unknown): string {return error instanceof Error ? error.message : String(error)}
const WORKER_HOME = path.resolve(process.env.BOT_REPORT_WORKER_HOME || path.join(os.homedir(), '.bot-report-worker'));
const CONFIG_PATH = path.join(WORKER_HOME, 'config.json');
const STATE_PATH = path.join(WORKER_HOME, 'state.json');
const PID_PATH = path.join(WORKER_HOME, 'worker.pid');
const LOG_PATH = path.join(WORKER_HOME, 'worker.log');
const DEFAULT_SERVER_PATH = path.join(WORKER_HOME, 'default-server');
const AGENT_PATH = path.join(__dirname, 'agent.js');

function fail(code: string, message: string) {return Object.assign(new Error(message), {code});}

function ensureHome() {
  fs.mkdirSync(WORKER_HOME, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(WORKER_HOME, 0o700); } catch (_) {}
}

function writeJsonAtomic(filePath: string, value: WorkerConfig | WorkerState) {
  ensureHome();
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function readJson<T extends object>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function readDefaultServer() {
  try { return fs.readFileSync(DEFAULT_SERVER_PATH, 'utf8').trim(); }
  catch (_) { return ''; }
}

function parseArgs(argv: string[]): {command: string; options: CliOptions} {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) return { command: 'help', options: {} };
  const command = argv[0];
  if (command.startsWith('-')) throw fail('CLI_COMMAND_UNKNOWN', `Unknown command '${command}'. Run bot-report-worker help.`);
  const args = argv.slice(1);
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw fail('CLI_ARGUMENT_INVALID', `Unexpected argument '${arg}'.`);
    const key = arg.slice(2);
    if (['allow-shell', 'no-start', 'insecure-http'].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw fail('CLI_ARGUMENT_INVALID', `Option '--${key}' requires a value.`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function validateServerUrl(value: unknown, allowInsecure: boolean) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch (_) { throw fail('WORKER_SERVER_URL_INVALID', 'Server URL must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw fail('WORKER_SERVER_URL_INVALID', 'Server URL must use HTTP or HTTPS.');
  if (parsed.protocol !== 'https:' && !allowInsecure) {
    throw fail('WORKER_TLS_REQUIRED', 'HTTPS is required. Use --insecure-http only for trusted local development.');
  }
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.origin;
}

function validateTmuxSession(value: unknown) {
  const session = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(session)) throw fail('INVALID_TMUX_SESSION', 'tmux session may contain only letters, numbers, underscore, dot, and hyphen.');
  return session;
}

function validateName(value: unknown, label = 'Worker name') {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/.test(name)) throw fail('WORKER_NAME_INVALID', `${label} must be 1-100 safe characters.`);
  return name;
}

function normalizeRoots(value: unknown) {
  const roots = (Array.isArray(value) ? value : String(value || '').split(','))
    .map(item => path.resolve(String(item).trim())).filter(Boolean);
  if (!roots.length) throw fail('WORKER_ALLOWED_ROOTS_REQUIRED', 'At least one allowed workspace root is required.');
  for (const root of roots) {
    let stat;
    try { stat = fs.statSync(root); } catch (_) { throw fail('WORKER_ROOT_NOT_FOUND', `Allowed root does not exist: ${root}`); }
    if (!stat.isDirectory()) throw fail('WORKER_ROOT_INVALID', `Allowed root is not a directory: ${root}`);
  }
  return [...new Set(roots)];
}

async function ask(question: string, defaultValue = '') {
  if (!stdin.isTTY) throw fail('CLI_INPUT_REQUIRED', `${question} must be supplied as a command option in non-interactive mode.`);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const value = (await rl.question(`${question}${suffix}: `)).trim();
    return value || defaultValue;
  } finally { rl.close(); }
}

async function askYesNo(question: string, defaultYes = false) {
  const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'}`)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return ['y', 'yes'].includes(answer);
}

async function askHidden(question: string) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return ask(question);
  stdout.write(`${question}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      try { stdin.setRawMode(false); } catch (_) {}
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          return resolve(value.trim());
        }
        if (char === '\u0003') {
          cleanup();
          return reject(fail('CLI_CANCELLED', 'Cancelled.'));
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

function generateIdentity() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

function commandExists(command: string) {
  return spawnSync('sh', ['-lc', `command -v ${command} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function ensureTmuxSession(session: string, cwd: string) {
  if (!commandExists('tmux')) return { available: false, created: false };
  const exists = spawnSync('tmux', ['has-session', '-t', `=${session}`], { stdio: 'ignore' });
  if (exists.status === 0) return { available: true, created: false };
  const created = spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', cwd], { encoding: 'utf8' });
  if (created.status !== 0) throw fail('TMUX_CREATE_FAILED', created.stderr?.trim() || `Unable to create tmux session '${session}'.`);
  return { available: true, created: true };
}

function workerEnv(config: WorkerConfig) {
  return {
    ...process.env,
    BOT_REPORT_WORKER_SERVER_URL: config.server_url,
    BOT_REPORT_WORKER_STATE_PATH: STATE_PATH,
    BOT_REPORT_WORKER_NAME: config.worker_name,
    BOT_REPORT_WORKER_ALLOWED_ROOTS: config.allowed_roots.join(','),
    BOT_REPORT_WORKER_ALLOW_SHELL: config.allow_shell ? 'true' : 'false',
    BOT_REPORT_WORKER_ALLOW_INSECURE_HTTP: config.allow_insecure_http ? 'true' : 'false',
    BOT_REPORT_WORKER_MAX_JOB_MS: String(config.max_job_ms || 300000),
    BOT_REPORT_WORKER_ENROLLMENT_TOKEN: ''
  };
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch (_) { return null; }
}

function pidAlive(pid: number | null) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function clearStalePid() {
  const pid = readPid();
  if (pid && pidAlive(pid)) return pid;
  try { fs.unlinkSync(PID_PATH); } catch (_) {}
  return null;
}

function logTail(maxBytes = 12 * 1024) {
  try {
    const stat = fs.statSync(LOG_PATH);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(LOG_PATH, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
}

async function waitForConnected(pid: number, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) throw fail('WORKER_START_FAILED', `Worker exited during startup.\n${logTail()}`);
    const log = logTail();
    if (/\[WORKER\] connected worker_id=/.test(log)) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw fail('WORKER_CONNECT_TIMEOUT', `Worker started but did not confirm connection within ${timeoutMs} ms.\n${logTail()}`);
}

async function startDetached({ wait = true }: {wait?: boolean} = {}) {
  const config = readJson<WorkerConfig>(CONFIG_PATH);
  const state = readJson<WorkerState>(STATE_PATH);
  if (!config || !state?.worker_id) throw fail('WORKER_NOT_LOGGED_IN', 'Run bot-report-worker login first.');
  const existing = clearStalePid();
  if (existing) {
    console.log(`[bot-report-worker] already running pid=${existing} profile=${config.profile_name}`);
    return existing;
  }
  ensureHome();
  const logFd = fs.openSync(LOG_PATH, 'a', 0o600);
  const child = spawn(process.execPath, [AGENT_PATH], {
    cwd: config.allowed_roots[0],
    env: workerEnv(config),
    detached: true,
    stdio: ['ignore', logFd, logFd]
  });
  fs.closeSync(logFd);
  child.unref();
  fs.writeFileSync(PID_PATH, `${child.pid}\n`, { mode: 0o600 });
  try {
    if (wait && child.pid) await waitForConnected(child.pid);
  } catch (error) {
    try { if (child.pid) process.kill(child.pid, 'SIGTERM'); } catch (_) {}
    try { fs.unlinkSync(PID_PATH); } catch (_) {}
    throw error;
  }
  console.log(`[bot-report-worker] connected profile=${config.profile_name} pid=${child.pid}`);
  return child.pid || 0;
}

async function stopWorker() {
  const pid = clearStalePid();
  if (!pid) {
    console.log('[bot-report-worker] not running');
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  const started = Date.now();
  while (pidAlive(pid) && Date.now() - started < 3000) await new Promise(resolve => setTimeout(resolve, 100));
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  }
  try { fs.unlinkSync(PID_PATH); } catch (_) {}
  console.log(`[bot-report-worker] stopped pid=${pid}`);
}

async function uninstallLocal() {
  await stopWorker();
  const plan = buildCleanupPlan({ runtimeDir: __dirname, workerHome: WORKER_HOME });
  const result = applyCleanupPlan(plan);
  console.log(`[bot-report-worker] uninstalled local_state=${result.local_state_removed ? 'removed' : 'kept'} installation=${result.installation_removed ? 'removed' : 'kept'}`);
}

async function login(options: CliOptions) {
  const existing = readJson<WorkerState>(STATE_PATH);
  if (existing?.worker_id) throw fail('WORKER_ALREADY_LOGGED_IN', `This machine is already enrolled as worker ${existing.worker_id}.`);

  const insecure = Boolean(options['insecure-http'] || process.env.BOT_REPORT_WORKER_ALLOW_INSECURE_HTTP === 'true');
  const serverInput = options.server || process.env.BOT_REPORT_WORKER_SERVER_URL || readDefaultServer() || await ask('mcp_worker server URL');
  const serverUrl = validateServerUrl(serverInput, insecure);
  const token = options.token || process.env.BOT_REPORT_WORKER_ENROLLMENT_TOKEN || await askHidden('One-time enrollment token');
  if (!token.startsWith('br_enroll_')) throw fail('WORKER_ENROLLMENT_INVALID', 'Enrollment token must start with br_enroll_.');
  const rootInput = options.roots || process.env.BOT_REPORT_WORKER_ALLOWED_ROOTS || await ask('Allowed workspace root(s), comma-separated', process.cwd());
  const roots = normalizeRoots(rootInput);
  const workerName = validateName(options.name || process.env.BOT_REPORT_WORKER_NAME || os.hostname());
  const profileName = validateName(options.profile || workerName, 'Profile name');
  const tmuxSession = validateTmuxSession(options.tmux || 'main');
  const allowShell = options['allow-shell'] === true || process.env.BOT_REPORT_WORKER_ALLOW_SHELL === 'true' ||
    (!options['allow-shell'] && !process.env.BOT_REPORT_WORKER_ALLOW_SHELL && await askYesNo('Allow mcp_worker to execute shell commands as this OS user?', false));

  ensureHome();
  const tmux = ensureTmuxSession(tmuxSession, roots[0]);
  const identity = generateIdentity();
  const response = await fetch(`${serverUrl}/worker/v1/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      name: workerName,
      public_key: identity.public_key,
      capabilities: DEFAULT_CAPABILITIES,
      create_profile: true,
      profile_name: profileName,
      tmux_session: tmuxSession
    })
  });
  const payload = await response.json().catch(() => ({})) as {code?: string; message?: string; worker_id?: string; name?: string; profile?: {name?: string; tmux_session?: string}};
  if (!response.ok) throw fail(payload.code || 'WORKER_ENROLLMENT_FAILED', payload.message || `Enrollment failed with HTTP ${response.status}.`);
  if (!payload.worker_id || !payload.profile?.name) throw fail('WORKER_ENROLLMENT_INCOMPLETE', 'Server did not return a Worker Profile.');

  const config = {
    server_url: serverUrl,
    worker_name: payload.name || workerName,
    profile_name: payload.profile.name,
    tmux_session: payload.profile.tmux_session,
    tmux_created_by_worker: Boolean(tmux.created),
    allowed_roots: roots,
    allow_shell: allowShell,
    allow_insecure_http: insecure,
    max_job_ms: 300000,
    updated_at: new Date().toISOString()
  };
  const state = {
    ...identity,
    worker_id: payload.worker_id,
    name: payload.name || workerName,
    server_url: serverUrl,
    enrolled_at: new Date().toISOString()
  };
  writeJsonAtomic(CONFIG_PATH, config);
  writeJsonAtomic(STATE_PATH, state);

  console.log(`[bot-report-worker] enrolled worker=${state.name} id=${state.worker_id}`);
  console.log(`[bot-report-worker] execution profile=${config.profile_name} roots=${roots.join(',')}`);
  console.log(`[bot-report-worker] shell execution=${allowShell ? 'ENABLED' : 'disabled'}`);
  if (tmux.available) console.log(`[bot-report-worker] tmux session=${config.tmux_session}${tmux.created ? ' (created)' : ''}`);
  else console.warn('[bot-report-worker] tmux not found; workspace/file/process jobs can still work, terminal operations require tmux.');

  if (!options['no-start']) await startDetached({ wait: true });
  else console.log('[bot-report-worker] enrollment complete; run bot-report-worker start to connect.');
}

async function runForeground() {
  const config = readJson<WorkerConfig>(CONFIG_PATH);
  const state = readJson<WorkerState>(STATE_PATH);
  if (!config || !state?.worker_id) throw fail('WORKER_NOT_LOGGED_IN', 'Run bot-report-worker login first.');
  const child = spawn(process.execPath, [AGENT_PATH], { cwd: config.allowed_roots[0], env: workerEnv(config), stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch (_) {} };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
  const code = await new Promise<number>(resolve => child.once('close', value => resolve(Number.isInteger(value) ? Number(value) : 1)));
  process.exitCode = code;
}

function printStatus() {
  const config = readJson<WorkerConfig>(CONFIG_PATH);
  const state = readJson<WorkerState>(STATE_PATH);
  const pid = clearStalePid();
  if (!config || !state?.worker_id) {
    console.log('status: NOT_LOGGED_IN');
    return;
  }
  console.log(`status: ${pid ? 'RUNNING' : 'STOPPED'}`);
  console.log(`worker_id: ${state.worker_id}`);
  console.log(`worker_name: ${state.name}`);
  console.log(`profile: ${config.profile_name}`);
  console.log(`server: ${config.server_url}`);
  console.log(`roots: ${config.allowed_roots.join(',')}`);
  console.log(`shell: ${config.allow_shell ? 'enabled' : 'disabled'}`);
  if (pid) console.log(`pid: ${pid}`);
  console.log(`log: ${LOG_PATH}`);
}

function printHelp() {
  console.log(`mcp_worker Worker 2.x\n\nUsage:\n  bot-report-worker login [options]\n  bot-report-worker start\n  bot-report-worker stop\n  bot-report-worker status\n  bot-report-worker logs\n  bot-report-worker run\n  bot-report-worker uninstall\n\nLogin options:\n  --server <url>       mcp_worker base URL (installer provides a default)\n  --token <token>      One-time enrollment token; omitted = hidden prompt\n  --roots <paths>      Comma-separated allowed workspace roots\n  --name <name>        Worker display name; default = hostname\n  --profile <name>     Execution alias; default = worker name\n  --tmux <session>     tmux session; default = main\n  --allow-shell        Allow workspace/git/check/process shell execution\n  --insecure-http      Permit HTTP only for trusted local development\n  --no-start           Enroll only; do not connect the worker\n\nAfter successful login the worker starts in the background and the returned profile alias is immediately available to mcp_worker.`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'login': return login(options);
    case 'start': return startDetached({ wait: true });
    case 'stop': return stopWorker();
    case 'status': return printStatus();
    case 'logs': return process.stdout.write(logTail(64 * 1024));
    case 'run': return runForeground();
    case 'uninstall': return uninstallLocal();
    case 'help':
    case '--help':
    case '-h': return printHelp();
    default: throw fail('CLI_COMMAND_UNKNOWN', `Unknown command '${command}'. Run bot-report-worker help.`);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[bot-report-worker] ${errorCode(error) || 'ERROR'}: ${errorMessage(error)}`);
    process.exit(1);
  });
}

export = {parseArgs, validateServerUrl, normalizeRoots, workerEnv, login, startDetached, stopWorker, uninstallLocal};
