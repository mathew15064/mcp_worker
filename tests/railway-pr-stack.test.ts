import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const checker = resolve(process.cwd(), 'scripts/check-railway-pr-stack.mjs');
type StackReport = {
  status: string;
  safeToMergeRailwayDirectly: boolean;
  ancestry: { vercelIsAncestor: boolean };
  aheadBehind: { vercelToRailway: { ahead: number; behind: number } };
  files: { sharedChanged: number; railwayIncremental: number };
  mergeBases: { vercelRailway: string | null };
  pinnedShaMismatches: string[];
  refs: { vercel: { sha: string }; base: { sha: string } };
};

function parseReport(stdout: string): StackReport {
  return JSON.parse(stdout) as StackReport;
}

function command(cwd: string, program: string, args: string[]) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function git(cwd: string, ...args: string[]): string {
  const result = command(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(cwd: string, name: string): void {
  writeFileSync(join(cwd, name + '.txt'), name + '\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', name);
}

function fixture(stacked: boolean) {
  const cwd = mkdtempSync(join(tmpdir(), 'railway-stack-guard-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'stack-guard@example.invalid');
  git(cwd, 'config', 'user.name', 'Stack Guard Test');
  commit(cwd, 'initial');
  git(cwd, 'branch', 'base');
  git(cwd, 'checkout', '-qb', 'vercel');
  commit(cwd, 'vercel-only');
  git(cwd, 'checkout', '-qb', 'railway', stacked ? 'vercel' : 'base');
  commit(cwd, 'railway-only');
  return cwd;
}

function check(cwd: string, ...extra: string[]) {
  return command(cwd, process.execPath, [
    checker,
    '--base',
    'base',
    '--vercel',
    'vercel',
    '--railway',
    'railway',
    '--json',
    ...extra,
  ]);
}

void test('stacked Vercel→Railway history is blocked under strict mode', () => {
  const cwd = fixture(true);
  try {
    const result = check(cwd, '--strict');
    assert.equal(result.status, 2, result.stderr);
    const report = parseReport(result.stdout);
    assert.equal(report.status, 'BLOCKED_STACKED');
    assert.equal(report.safeToMergeRailwayDirectly, false);
    assert.equal(report.ancestry.vercelIsAncestor, true);
    assert.deepEqual(report.aheadBehind.vercelToRailway, { ahead: 1, behind: 0 });
    assert.equal(report.files.sharedChanged, 1);
    assert.equal(report.files.railwayIncremental, 1);
    assert.equal(report.mergeBases.vercelRailway, report.refs.vercel.sha);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test('independent sibling Railway series passes strict mode', () => {
  const cwd = fixture(false);
  try {
    const result = check(cwd, '--strict');
    assert.equal(result.status, 0, result.stderr);
    const report = parseReport(result.stdout);
    assert.equal(report.status, 'PASS_INDEPENDENT');
    assert.equal(report.safeToMergeRailwayDirectly, true);
    assert.equal(report.mergeBases.vercelRailway, report.refs.base.sha);
    assert.deepEqual(report.aheadBehind.vercelToRailway, { ahead: 1, behind: 1 });
    assert.equal(report.files.sharedChanged, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test('base ref drift fails closed instead of passing unrelated histories', () => {
  const cwd = fixture(false);
  try {
    git(cwd, 'checkout', '-q', 'base');
    commit(cwd, 'base-advanced');
    const result = check(cwd, '--strict');
    assert.equal(result.status, 2, result.stderr);
    assert.equal(parseReport(result.stdout).status, 'BLOCKED_BASE_DRIFT');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test('suspicious, missing, or option-like refs are rejected', () => {
  const cwd = fixture(false);
  try {
    for (const ref of ['base..railway', '--upload-pack=evil', 'base@{1}', '../bad', 'foo bar']) {
      const result = check(cwd, '--vercel', ref, '--strict');
      assert.equal(result.status, 64, ref + ': ' + result.stderr);
      assert.match(result.stderr, /Invalid or unsafe ref/);
    }
    const missing = check(cwd, '--vercel', 'missing-ref');
    assert.equal(missing.status, 64);
    assert.match(missing.stderr, /Missing or non-commit ref/);
    const noValue = check(cwd, '--base');
    assert.equal(noValue.status, 64);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test('inspection never changes checked out commit, refs, or worktree', () => {
  const cwd = fixture(true);
  try {
    const beforeHead = git(cwd, 'rev-parse', 'HEAD');
    const beforeRefs = git(cwd, 'show-ref');
    const beforeTree = git(cwd, 'status', '--porcelain');
    const result = check(cwd, '--strict');
    assert.equal(result.status, 2);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), beforeHead);
    assert.equal(git(cwd, 'show-ref'), beforeRefs);
    assert.equal(git(cwd, 'status', '--porcelain'), beforeTree);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test('help does not need a Git repository, and unknown options fail', () => {
  const help = command(tmpdir(), process.execPath, [checker, '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /read-only|No fetch/i);
  const unknown = command(tmpdir(), process.execPath, [checker, '--force']);
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /Unknown argument/);
});

void test('pinned source SHAs reject drift even when branch ancestry is independent', () => {
  const cwd = fixture(false);
  try {
    const base = git(cwd, 'rev-parse', 'base');
    const vercel = git(cwd, 'rev-parse', 'vercel');
    const railway = git(cwd, 'rev-parse', 'railway');
    const pins = [
      '--expect-base-sha',
      base,
      '--expect-vercel-sha',
      vercel,
      '--expect-railway-sha',
      railway,
    ];
    const accepted = check(cwd, ...pins, '--strict');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(parseReport(accepted.stdout).status, 'PASS_INDEPENDENT');
    assert.deepEqual(parseReport(accepted.stdout).pinnedShaMismatches, []);

    const stale = check(cwd, '--expect-vercel-sha', '0'.repeat(40), '--strict');
    assert.equal(stale.status, 2, stale.stderr);
    const report = parseReport(stale.stdout);
    assert.equal(report.status, 'BLOCKED_REF_DRIFT');
    assert.deepEqual(report.pinnedShaMismatches, ['vercel']);
    assert.equal(report.safeToMergeRailwayDirectly, false);

    const malformed = check(cwd, '--expect-base-sha', 'not-a-sha', '--strict');
    assert.equal(malformed.status, 64);
    assert.match(malformed.stderr, /Invalid or missing expected SHA/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test('unmodified TS6 base is not accepted as a Railway candidate', () => {
  const cwd = fixture(false);
  try {
    const result = check(cwd, '--railway', 'base', '--strict');
    assert.equal(result.status, 2);
    assert.equal(parseReport(result.stdout).status, 'BLOCKED_EMPTY_CANDIDATE');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
