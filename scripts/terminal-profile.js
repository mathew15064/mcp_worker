#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline/promises');
const { execFileSync } = require('child_process');
const databaseManager = require('../src/db/databaseManager');
const runtimeSettings = require('../src/services/runtimeSettingsService');
const { closeDb } = require('../src/db/connection');
const repo = require('../src/repositories/terminalProfileRepository');
const workerRepo = require('../src/repositories/workerRepository');
const credentials = require('../src/services/terminalCredentialService');

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { out._.push(value); continue; }
    const key = value.slice(2);
    if (key === 'password-stdin') { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}
function boolean(value, fallback = true) {
  if (value === undefined) return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}
async function hidden(prompt) {
  if (!process.stdin.isTTY) throw new Error('Password input requires a TTY or --password-stdin.');
  process.stdout.write(prompt);
  try { execFileSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'inherit'] }); } catch (_) {}
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(''); }
  finally {
    rl.close();
    try { execFileSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'inherit'] }); } catch (_) {}
    process.stdout.write('\n');
  }
}
async function password(args) {
  if (args['password-stdin']) return fs.readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
  return hidden('SSH password: ');
}
function usage() {
  console.log(`Usage:
  npm run terminal-profile -- list
  npm run terminal-profile -- add --name NAME --host HOST --port 22 --user USER --tmux SESSION [--description TEXT] [--enabled true] [--password-stdin]
  npm run terminal-profile -- edit NAME [--host HOST] [--port 22] [--user USER] [--tmux SESSION] [--description TEXT] [--enabled true|false] [--password-stdin]
  npm run terminal-profile -- delete NAME

Uses the active application data store (MySQL after cutover, legacy SQLite during migration).
Passwords are never accepted as command-line arguments.`);
}
async function find(name) {
  const ref = await repo.findByNameCaseInsensitive(name);
  return ref ? repo.findById(ref.id) : null;
}
async function bootstrapStorage() {
  await databaseManager.initialize();
  if (!databaseManager.isOperational()) throw new Error('Database is not configured or available. Configure MySQL from /admin/settings.');
  await runtimeSettings.load(databaseManager.getAdapter());
}
async function main() {
  await bootstrapStorage();
  const args = parse(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || ['-h', 'help'].includes(cmd)) return usage();
  if (cmd === 'list') {
    console.table((await repo.findAll()).map(({ name, description, host, port, username, tmux_session, enabled }) => ({ name, description, host, port, username, tmux_session, enabled })));
    return;
  }
  if (cmd === 'add') {
    if (await workerRepo.findProfileByName(args.name)) throw new Error('A Worker Profile already uses this name. Execution profile aliases must be unique across transports.');
    const secret = await password(args);
    const row = await repo.create({
      name: args.name, description: args.description || '', host: args.host,
      port: args.port || '22', username: args.user, tmux_session: args.tmux,
      enabled: boolean(args.enabled, true)
    }, credentials.encrypt(secret));
    console.log(`Created Terminal Profile '${row.name}'.`);
    return;
  }
  const name = args._[1];
  if (!name) throw new Error(`${cmd} requires a profile name.`);
  const existing = await find(name);
  if (!existing) throw new Error(`Terminal Profile '${name}' not found.`);
  if (cmd === 'delete') {
    await repo.delete(existing.id);
    console.log(`Deleted Terminal Profile '${existing.name}'.`);
    return;
  }
  if (cmd === 'edit') {
    const input = {
      name: args.name || existing.name,
      description: args.description !== undefined ? args.description : (existing.description || ''),
      host: args.host || existing.host,
      port: args.port || existing.port,
      username: args.user || existing.username,
      tmux_session: args.tmux || existing.tmux_session,
      enabled: args.enabled !== undefined ? boolean(args.enabled) : existing.enabled
    };
    if (await workerRepo.findProfileByName(input.name)) throw new Error('A Worker Profile already uses this name. Execution profile aliases must be unique across transports.');
    const envelope = args['password-stdin'] ? credentials.encrypt(await password(args)) : null;
    const row = await repo.update(existing.id, input, envelope);
    console.log(`Updated Terminal Profile '${row.name}'.`);
    return;
  }
  throw new Error(`Unknown command '${cmd}'.`);
}
main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }).finally(async () => {
  try { await databaseManager.close(); } catch (_) {}
  closeDb();
});
