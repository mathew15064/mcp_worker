/**
 * Incremental quality gate. Existing debt is recorded explicitly; new debt
 * cannot enter CI. Baseline regeneration is an intentional developer action,
 * never a CI action. Run ESLint directly to see every finding.
 */
import { ESLint } from 'eslint';
import prettier from 'prettier';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const baselinePath = path.join(root, 'quality', 'baseline.json');
const targets = [
  'src/**/*.ts',
  'worker/**/*.ts',
  'scripts/**/*.ts',
  'tests/**/*.ts',
  'playwright.config.ts',
];
const mode = process.argv[2] ?? 'check';
if (!['check', 'record'].includes(mode)) throw new Error('Use check or record');
const eslint = new ESLint({ cwd: root });
const results = await eslint.lintFiles(targets);
const current = { lint: {}, format: {} };
let total = 0;
const fatal = [];
const relative = (file) => path.relative(root, file).split(path.sep).join('/');
for (const result of results) {
  const name = relative(result.filePath);
  for (const message of result.messages) {
    if (message.fatal || !message.ruleId) {
      fatal.push(`${name}:${message.line} ${message.message}`);
      continue;
    }
    // Baseline only existing rule findings, never syntax/parser errors.
    const counts = (current.lint[name] ??= {});
    counts[message.ruleId] = (counts[message.ruleId] ?? 0) + 1;
    total++;
  }
  const source = await fs.readFile(result.filePath, 'utf8');
  const options = await prettier.resolveConfig(result.filePath);
  if (!(await prettier.check(source, { ...options, filepath: result.filePath }))) {
    current.format[name] = crypto.createHash('sha256').update(source).digest('hex');
    // Temporary diagnostic: exact formatting of reviewed Quickstart changes.
    if ([
      'src/services/distributedWorkerRelay.ts',
      'tests/vercel-distributed-worker.test.ts',
      'tests/vercel-template-core.test.ts'
    ].includes(name)) {
      const formatted = await prettier.format(source, { ...options, filepath: result.filePath });
      console.error('FORMAT_DIAGNOSTIC_BEGIN:' + name + ':' + Buffer.from(formatted).toString('base64') + ':FORMAT_DIAGNOSTIC_END');
    }
  }
}
if (fatal.length) {
  console.error(fatal.join('\n'));
  process.exitCode = 1;
} else if (mode === 'record') {
  const sort = (obj) =>
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
  current.lint = sort(current.lint);
  for (const file of Object.keys(current.lint)) current.lint[file] = sort(current.lint[file]);
  current.format = sort(current.format);
  await fs.writeFile(baselinePath, JSON.stringify(current, null, 2) + '\n');
  console.log('Recorded explicit baseline; review changes before committing.');
} else {
  const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
  const violations = [];
  // A committed baseline cannot be inflated to hide newly added debt.
  // On the initial adoption commit only, the base has no baseline yet.
  const baseRef = process.env.QUALITY_BASE_REF;
  if (baseRef && !/^0+$/.test(baseRef)) {
    if (!/^[0-9a-f]{40}$/.test(baseRef)) throw new Error('Invalid quality base commit');
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['cat-file', '-e', baseRef + '^{commit}']);
    const previousPath = git(['ls-tree', '--name-only', baseRef, 'quality/baseline.json']).trim();
    if (previousPath) {
      const previous = JSON.parse(git(['show', baseRef + ':quality/baseline.json']));
      for (const [file, rules] of Object.entries(baseline.lint)) {
        for (const [rule, count] of Object.entries(rules)) {
          if (count > (previous.lint[file]?.[rule] ?? 0)) {
            violations.push(`${file}: committed lint baseline increased for ${rule}`);
          }
        }
      }
      for (const [file, hash] of Object.entries(baseline.format)) {
        if (previous.format[file] !== hash) {
          violations.push(`${file}: committed formatting baseline expanded or changed`);
        }
      }
    }
  }
  for (const [file, rules] of Object.entries(current.lint)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = baseline.lint[file]?.[rule] ?? 0;
      if (count > allowed) violations.push(`${file}: ${rule} ${count} > ${allowed}`);
    }
  }
  for (const [file, hash] of Object.entries(current.format)) {
    if (baseline.format[file] !== hash)
      violations.push(`${file}: format changed/new file with Prettier`);
  }
  // Prevent stale allowances from being retained after a debt reduction.
  for (const [file, rules] of Object.entries(baseline.lint)) {
    for (const [rule, count] of Object.entries(rules)) {
      if ((current.lint[file]?.[rule] ?? 0) < count)
        violations.push(`${file}: reduced ${rule}; update baseline explicitly`);
    }
  }
  for (const file of Object.keys(baseline.format)) {
    if (!(file in current.format))
      violations.push(`${file}: formatting debt removed; update baseline explicitly`);
  }
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Quality gate PASS: no new lint or formatting debt.');
  }
}
console.log(
  `Type-aware lint: ${results.length} files, ${total} findings; formatting debt: ${Object.keys(current.format).length} files.`,
);
