#!/usr/bin/env node
'use strict';

// Runs *inside* the published Node image; never expose generated secrets to stdout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '/setup/.env.setup') {
    throw new Error('Usage: node dist/scripts/quick-setup.cjs /setup/.env.setup');
  }
  const file = process.argv[2];
  const parent = path.dirname(file);
  const info = fs.lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(parent) !== parent) {
    throw new Error('Setup directory must be a real directory.');
  }
  process.umask(0o077);
  if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) {
    const existing = fs.lstatSync(file);
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) {
      throw new Error('Existing .env.setup is not a private regular file.');
    }
    const value = fs.readFileSync(file, 'utf8');
    for (const name of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'APP_ENCRYPTION_KEY']) {
      if (!new RegExp('^' + name + '=[^\\n]+$', 'm').test(value)) {
        throw new Error('Existing .env.setup is incomplete; restore the original file.');
      }
    }
    console.log('Existing private .env.setup preserved.');
    return;
  }

  const port = process.env.MCP_WORKER_SETUP_PORT || '3333';
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Invalid MCP_WORKER_SETUP_PORT.');
  }
  const publicOrigin = process.env.MCP_PUBLIC_BASE_URL || '';
  const url = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== publicOrigin ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MCP_PUBLIC_BASE_URL must be an HTTP(S) origin without path, query or credentials.');
  }
  const body = [
    'MCP_WORKER_PORT=' + port,
    'MCP_PUBLIC_BASE_URL=' + publicOrigin,
    'MCP_ENABLED=true',
    'ADMIN_USERNAME=admin',
    'ADMIN_PASSWORD=' + crypto.randomBytes(24).toString('hex'),
    'SESSION_SECRET=' + crypto.randomBytes(32).toString('hex'),
    'APP_ENCRYPTION_KEY=' + crypto.randomBytes(32).toString('base64'),
    '',
  ].join('\n');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(fd, body, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  console.log('Created private .env.setup (0600) on host-mounted setup directory.');
}

try { main(); }
catch (error) { console.error('Quick setup refused: ' + (error instanceof Error ? error.message : 'unknown error')); process.exitCode = 1; }
