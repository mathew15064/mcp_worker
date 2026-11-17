#!/usr/bin/env node
'use strict';
// Generate fail-closed PRIVATE review templates. No tag, upload, or signing occurs.
const fs = require('node:fs');
const path = require('node:path');
const routes = require('../dist/src/routes/workerRoutes.js');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'worker', 'dev-bin', 'github-rc');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
for (const [file, fn] of [
  ['install-linux.sh', routes.githubLinuxInstallerScript],
  ['install-macos.sh', routes.githubMacInstallerScript],
  ['install-windows.ps1', routes.githubWindowsInstallerScript],
]) {
  if (typeof fn !== 'function') throw Error('Missing GitHub installer renderer: ' + file);
  const text = fn();
  if (!text.includes('Signed release not approved') && !text.includes('signed release not approved'))
    throw Error('Unapproved RC template must fail closed');
  fs.writeFileSync(path.join(out, file), text, { mode: 0o600 });
}
console.log('Fail-closed GitHub RC installer templates:', out);
