#!/usr/bin/env node
import databaseManager = require('../src/db/databaseManager');
import runtimeSettings = require('../src/services/runtimeSettingsService');
import {closeDb} from '../src/db/connection';
import service = require('../src/services/mcpOAuthService');
import repo = require('../src/repositories/mcpOAuthRepository');

interface Args {_: string[]; redirect: string[]; name?: string; principal?: string; scopes?: string}
function parse(argv: string[]): Args {
  const out: Args = { _: [], redirect: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { out._.push(value); continue; }
    const key = value.slice(2);
    const next = argv[++i];
    if (key === 'redirect' && next) out.redirect.push(next);
    else if (key === 'name' || key === 'principal' || key === 'scopes') out[key] = next;
  }
  return out;
}
function scopes(value: unknown) {
  return String(value || 'bot_report.read bot_report.terminal offline_access').split(/[\s,]+/).filter(Boolean);
}
function usage() {
  console.log(`Usage:
  npm run mcp-client -- list
  npm run mcp-client -- add --name NAME --principal PRINCIPAL --redirect URI [--redirect URI2] [--scopes "bot_report.read bot_report.terminal offline_access"]
  npm run mcp-client -- rotate CLIENT_ID
  npm run mcp-client -- enable CLIENT_ID
  npm run mcp-client -- disable CLIENT_ID
  npm run mcp-client -- revoke CLIENT_ID
  npm run mcp-client -- delete CLIENT_ID`);
}
async function byClientId(clientId: string) {
  const client = await repo.findClientByClientId(clientId);
  if (!client) throw new Error(`OAuth client '${clientId}' not found.`);
  return client;
}
function printSecret(result: {client: {client_id: string} | null; rawSecret: string}) {
  if (!result.client) throw new Error('Client was not returned by OAuth service');
  console.log(`client_id=${result.client.client_id}`);
  console.log(`client_secret=${result.rawSecret}`);
  console.log('Store the secret now; only its hash is persisted.');
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
  if (!cmd || ['help', '-h'].includes(cmd)) return usage();
  if (cmd === 'list') {
    console.table((await repo.listClients()).filter((v): v is NonNullable<typeof v> => v !== null).map(({ client_id, display_name, principal_id, status, allowed_scopes, redirect_uris }) => ({ client_id, display_name, principal_id, status, scopes: allowed_scopes.join(' '), redirects: redirect_uris.join(', ') })));
    return;
  }
  if (cmd === 'add') {
    if (!args.name || !args.principal || args.redirect.length === 0) throw new Error('add requires --name, --principal, and at least one --redirect.');
    return printSecret(await service.registerClient({ displayName: args.name, principalId: args.principal, redirectUris: args.redirect, allowedScopes: scopes(args.scopes) }));
  }
  const clientId = args._[1];
  if (!clientId) throw new Error(`${cmd} requires CLIENT_ID.`);
  const client = await byClientId(clientId);
  if (cmd === 'rotate') return printSecret(await service.rotateClientSecret(clientId));
  if (cmd === 'enable') await repo.updateClientStatus(client.id, 'active');
  else if (cmd === 'disable') await repo.updateClientStatus(client.id, 'disabled');
  else if (cmd === 'revoke') { await repo.updateClientStatus(client.id, 'revoked'); await repo.revokeAllTokensByClientId(clientId); }
  else if (cmd === 'delete') await repo.deleteClient(client.id);
  else throw new Error(`Unknown command '${cmd}'.`);
  console.log(`${cmd} completed for '${clientId}'.`);
}
main().catch((error: unknown) => { console.error(`ERROR: ${(error instanceof Error ? error.message : String(error))}`); process.exitCode = 1; }).finally(async () => {
  try { await databaseManager.close(); } catch (_) {}
  closeDb();
});
