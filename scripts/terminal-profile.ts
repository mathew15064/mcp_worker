#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline/promises';
import {execFileSync} from 'node:child_process';
import databaseManager = require('../src/db/databaseManager');
import runtimeSettings = require('../src/services/runtimeSettingsService');
import {closeDb} from '../src/db/connection';
import repo = require('../src/repositories/terminalProfileRepository');
import workerRepo = require('../src/repositories/workerRepository');
import credentials = require('../src/services/terminalCredentialService');

interface Args {_: string[]; [key: string]: string[] | string | boolean | undefined}
function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { out._.push(value); continue; }
    const key = value.slice(2);
    if (key === 'password-stdin') { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}
function boolean(value: unknown, fallback = true) {
  if (value === undefined) return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}
async function hidden(prompt: string) {
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
async function password(args: Args) {
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
async function find(name: string) {
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
  const flag = (name: string) => typeof args[name] === 'string' ? args[name] as string : undefined;
  const cmd = args._[0];
  if (!cmd || ['-h', 'help'].includes(cmd)) return usage();
  if (cmd === 'list') {
    console.table((await repo.findAll()).map(({ name, description, host, port, username, tmux_session, enabled }) => ({ name, description, host, port, username, tmux_session, enabled })));
    return;
  }
  if (cmd === 'add') {
    const requestedName = flag('name');
    if (!requestedName) throw new Error('add requires --name.');
    if (await workerRepo.findProfileByName(requestedName)) throw new Error('A Worker Profile already uses this name. Execution profile aliases must be unique across transports.');
    const secret = await password(args);
    const row = await repo.create({
      name: flag('name'), description: flag('description') || '', host: flag('host'),
      port: flag('port') || '22', username: flag('user'), tmux_session: flag('tmux'),
      enabled: boolean(flag('enabled'), true)
    }, credentials.encrypt(secret));
    if (!row) throw new Error('Profile creation returned no record');
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
      name: flag('name') || existing.name,
      description: flag('description') !== undefined ? flag('description') : (existing.description || ''),
      host: flag('host') || existing.host,
      port: flag('port') || existing.port,
      username: flag('user') || existing.username,
      tmux_session: flag('tmux') || existing.tmux_session,
      enabled: flag('enabled') !== undefined ? boolean(flag('enabled')) : existing.enabled
    };
    if (await workerRepo.findProfileByName(input.name)) throw new Error('A Worker Profile already uses this name. Execution profile aliases must be unique across transports.');
    const envelope = args['password-stdin'] ? credentials.encrypt(await password(args)) : null;
    const row = await repo.update(existing.id, input, envelope);
    if (!row) throw new Error('Profile update returned no record');
    console.log(`Updated Terminal Profile '${row.name}'.`);
    return;
  }
  throw new Error(`Unknown command '${cmd}'.`);
}
main().catch((error: unknown) => { console.error(`ERROR: ${(error instanceof Error ? error.message : String(error))}`); process.exitCode = 1; }).finally(async () => {
  try { await databaseManager.close(); } catch (_) {}
  closeDb();
});
