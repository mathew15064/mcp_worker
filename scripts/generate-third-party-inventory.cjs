#!/usr/bin/env node
'use strict';
// Lockfile-based candidate inventory only; NOT a replacement for license notices.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const packages = Object.entries(lock.packages || {}).filter(([name]) => name.startsWith('node_modules/'));
if (!packages.length) throw new Error('No package-lock inventory found');
const runtime = packages.filter(([, info]) => !info.dev).map(([key, info]) => {
  if (!info.version || !info.integrity || !info.resolved?.startsWith('https://registry.npmjs.org/')) {
    throw new Error('Missing pinned registry provenance for ' + key);
  }
  return { name: key.slice('node_modules/'.length), version: info.version, license: info.license || 'UNDECLARED (manual review)' };
}).sort((a, b) => a.name.localeCompare(b.name));
const lines = [
  '# Candidate Node.js runtime dependency inventory',
  '',
  'Generated from the committed root package-lock.json using node scripts/generate-third-party-inventory.cjs.',
  'This is a metadata inventory for review, NOT a license notice bundle, an SBOM, or permission to redistribute.',
  'Inspect actual installed LICENSE/NOTICE texts and Docker image components before publication.',
  '',
  'Non-root npm packages: ' + packages.length + '; runtime/non-dev: ' + runtime.length + '; dev-only: ' + (packages.length - runtime.length) + '.',
  '',
  '| Package | Locked version | Declared license |',
  '| --- | --- | --- |',
];
for (const item of runtime) {
  const esc = value => String(value).replace(/\|/g, '\\|');
  lines.push('| ' + esc(item.name) + ' | ' + esc(item.version) + ' | ' + esc(item.license) + ' |');
}
process.stdout.write(lines.join('\n') + '\n');
