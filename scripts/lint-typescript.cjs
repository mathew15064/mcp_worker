#!/usr/bin/env node
'use strict';
// Syntax and migration safety lint, intentionally dependency-free beyond the
// already pinned TypeScript compiler. This does not replace strict typecheck.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const roots = ['src', 'worker', 'scripts', 'tests'];
const strictModules = new Set(['src/http/pages.ts','src/services/terminalSshService.ts','tests/ts5-render-ssh.test.ts']);
let checked = 0;
let violations = 0;
function visit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) { visit(file); continue; }
    if (!ent.isFile()) continue;
    if (file.endsWith('.js') && dir !== path.join(root, 'tests') && !file.split(path.sep).includes('tests')) {
      console.error('Unmigrated production JavaScript source: ' + path.relative(root, file));
      violations++;
    }
    if (!file.endsWith('.ts')) continue;
    const name = path.relative(root, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    checked++;
    if (/\@ts-(?:nocheck|ignore)\b/i.test(source)) {
      console.error('Disallowed TypeScript suppression: ' + name); violations++;
    }
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    for (const error of tree.parseDiagnostics) {
      console.error('TypeScript syntax ' + name + ':' + tree.getLineAndCharacterOfPosition(error.start || 0).line + ': ' + ts.flattenDiagnosticMessageText(error.messageText, '\n'));
      violations++;
    }
    if (strictModules.has(name)) {
      const walk = node => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          const loc = tree.getLineAndCharacterOfPosition(node.getStart(tree));
          console.error('Explicit any in newly migrated source: ' + name + ':' + (loc.line + 1));
          violations++;
        }
        ts.forEachChild(node, walk);
      };
      walk(tree);
    }
  }
}
for (const dir of roots) visit(path.join(root, dir));
if (violations) process.exitCode = 1;
else console.log('TypeScript source lint PASS: ' + checked + ' files parsed; no typecheck suppression; TS5 modules contain no any.');
