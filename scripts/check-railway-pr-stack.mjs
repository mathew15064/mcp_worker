#!/usr/bin/env node
/**
 * Read-only Git history guard for Railway PR #15 vs. Vercel PR #14.
 * Uses only local Git object/ref queries. This program never fetches, checks
 * out, rebases, updates refs, contacts GitHub, or touches deployment state.
 */
import { execFileSync } from 'node:child_process';

const defaults = {
  base: 'origin/refactor/typescript-ts6',
  vercel: 'origin/feature/vercel-selfhost-20261112',
  railway: 'origin/feature/railway-sqlite-oneclick-20261112',
};

function usage() {
  return [
    'Usage: node scripts/check-railway-pr-stack.mjs [options]',
    '  --base REF       Approved target base (default: origin/refactor/typescript-ts6)',
    '  --vercel REF     Vercel PR #14 head (default: origin/feature/vercel-selfhost-20261112)',
    '  --railway REF    Railway PR #15 head (default: origin/feature/railway-sqlite-oneclick-20261112)',
    '  --expect-base-sha SHA     Require an exact 40-character base commit SHA',
    '  --expect-vercel-sha SHA   Require an exact Vercel PR head SHA',
    '  --expect-railway-sha SHA  Require an exact Railway/candidate head SHA',
    '  --json           Machine-readable result',
    '  --strict         Exit 2 unless the two histories are independently based',
    '  --help           Show this text',
    'No fetch/checkout/merge/rebase/deploy is performed. Fetch refs separately before invoking.',
  ].join('\n');
}

function validRef(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('/.') &&
    !value.endsWith('.') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock')
  );
}

function parseArgs(argv) {
  const options = { ...defaults, json: false, strict: false, expectedShas: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    if (flag === '--json' || flag === '--strict') {
      options[flag.slice(2)] = true;
      continue;
    }
    if (['--expect-base-sha', '--expect-vercel-sha', '--expect-railway-sha'].includes(flag)) {
      const next = argv[++index];
      if (!/^[0-9a-fA-F]{40}$/.test(next || ''))
        throw new Error('Invalid or missing expected SHA for ' + flag);
      options.expectedShas[flag.slice(9, -4)] = next.toLowerCase();
      continue;
    }
    if (flag === '--base' || flag === '--vercel' || flag === '--railway') {
      const next = argv[++index];
      if (!validRef(next)) throw new Error('Invalid or unsafe ref for ' + flag);
      options[flag.slice(2)] = next;
      continue;
    }
    throw new Error('Unknown argument: ' + String(flag));
  }
  return options;
}

function git(args) {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function resolved(ref) {
  try {
    return git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']);
  } catch {
    throw new Error('Missing or non-commit ref: ' + ref + ' (fetch it separately)');
  }
}

function ancestor(older, newer) {
  try {
    git(['merge-base', '--is-ancestor', older, newer]);
    return true;
  } catch {
    return false;
  }
}

function mergeBase(left, right) {
  try {
    return git(['merge-base', left, right]);
  } catch {
    return null;
  }
}

function count(left, right) {
  return Number(git(['rev-list', '--count', left + '..' + right]));
}

function changed(left, right) {
  if (!left) return [];
  const output = git(['diff', '--name-only', '--find-renames', left, right]);
  return output ? output.split('\n').sort() : [];
}

function inspect(options) {
  const base = resolved(options.base);
  const vercel = resolved(options.vercel);
  const railway = resolved(options.railway);
  const mbBV = mergeBase(base, vercel);
  const mbBR = mergeBase(base, railway);
  const mbVR = mergeBase(vercel, railway);
  const baseToVercel = changed(mbBV, vercel);
  const baseToRailway = changed(mbBR, railway);
  const railwayIncremental = changed(mbVR, railway);
  const overlap = baseToVercel.filter((file) => baseToRailway.includes(file));
  const incrementalOverlap = railwayIncremental.filter((file) => baseToVercel.includes(file));
  const counts = {
    baseToVercel: { ahead: count(base, vercel), behind: count(vercel, base) },
    baseToRailway: { ahead: count(base, railway), behind: count(railway, base) },
    vercelToRailway: { ahead: count(vercel, railway), behind: count(railway, vercel) },
  };
  const baseIsAncestor = ancestor(base, vercel) && ancestor(base, railway);
  const vercelIsAncestor = ancestor(vercel, railway);
  const railwayIsAncestor = ancestor(railway, vercel);
  let status = 'BLOCKED_AMBIGUOUS';
  if (!mbBV || !mbBR || !mbVR) status = 'BLOCKED_UNRELATED';
  else if (vercelIsAncestor && counts.baseToVercel.ahead > 0) status = 'BLOCKED_STACKED';
  else if (railwayIsAncestor && counts.baseToRailway.ahead > 0) status = 'BLOCKED_REVERSED';
  else if (!baseIsAncestor) status = 'BLOCKED_BASE_DRIFT';
  else if (counts.baseToRailway.ahead === 0) status = 'BLOCKED_EMPTY_CANDIDATE';
  else if (mbVR === base) status = 'PASS_INDEPENDENT';
  const pinnedShaMismatches = ['base', 'vercel', 'railway'].filter(
    (name) =>
      options.expectedShas[name] && options.expectedShas[name] !== { base, vercel, railway }[name],
  );
  if (pinnedShaMismatches.length) status = 'BLOCKED_REF_DRIFT';

  const warnings = [];
  if (status === 'BLOCKED_REF_DRIFT') {
    warnings.push(
      'A pinned head SHA does not match the checked Git ref; refresh and re-review before proceeding.',
    );
  } else if (status === 'BLOCKED_STACKED') {
    warnings.push(
      'Railway head contains the complete Vercel head history; merging it directly into base also introduces Vercel commits.',
    );
  } else if (status !== 'PASS_INDEPENDENT') {
    warnings.push(
      'Topology is not a verified independent Railway series; review/refetch and approve an explicit dependency graph.',
    );
  }
  if (counts.baseToVercel.behind || counts.baseToRailway.behind) {
    warnings.push(
      'At least one PR branch is behind the specified base. Review base drift before relying on this snapshot.',
    );
  }
  if (status === 'PASS_INDEPENDENT') {
    warnings.push(
      'Ancestry only: this PASS does not certify portable auth, SQLite, Worker behavior or release readiness.',
    );
  }
  if (incrementalOverlap.length) {
    warnings.push(
      'Railway incremental commits modify files already touched by Vercel; review individual hunks and shared contracts.',
    );
  }

  return {
    schemaVersion: 2,
    status,
    expectedShas: options.expectedShas,
    pinnedShaMismatches,
    safeToMergeRailwayDirectly: status === 'PASS_INDEPENDENT',
    refs: {
      base: { name: options.base, sha: base },
      vercel: { name: options.vercel, sha: vercel },
      railway: { name: options.railway, sha: railway },
    },
    mergeBases: { baseVercel: mbBV, baseRailway: mbBR, vercelRailway: mbVR },
    aheadBehind: counts,
    ancestry: { baseIsAncestor, vercelIsAncestor, railwayIsAncestor },
    files: {
      vercelChanged: baseToVercel.length,
      railwayChanged: baseToRailway.length,
      sharedChanged: overlap.length,
      railwayIncremental: railwayIncremental.length,
      incrementalOverlappingVercel: incrementalOverlap,
      railwayIncrementalPaths: railwayIncremental,
    },
    warnings,
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const result = inspect(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('Railway PR stack: ' + result.status);
      console.log(
        'base→Vercel: +' +
          result.aheadBehind.baseToVercel.ahead +
          '/-' +
          result.aheadBehind.baseToVercel.behind +
          '; base→Railway: +' +
          result.aheadBehind.baseToRailway.ahead +
          '/-' +
          result.aheadBehind.baseToRailway.behind +
          '; Vercel→Railway: +' +
          result.aheadBehind.vercelToRailway.ahead +
          '/-' +
          result.aheadBehind.vercelToRailway.behind,
      );
      for (const warning of result.warnings) console.warn('WARNING: ' + warning);
    }
    if (options.strict && !result.safeToMergeRailwayDirectly) process.exitCode = 2;
  }
} catch (error) {
  console.error('Stack checker error: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 64;
}
