# TS6.1: Code quality foundation

TS5 is the accepted functional baseline. TS6 changes maintainability, not the
MCP wire contract or the native Go Worker. All work stays on the TS6 branch.

## Commands

- `npm run typecheck`: strict compiler check (unchanged).
- `npm run lint`: source migration and suppression guard (unchanged).
- `npm run lint:typed`: full ESLint recommendedTypeChecked report, including
  unsafe values, floating promises, unused variables, require imports and
  non-null assertions. This intentionally exits nonzero while debt exists.
- `npm run format:check`: full Prettier check; reports remaining formatting debt.
- `npm run format:write`: format TypeScript source, tests and Playwright config.
  Prefer formatting individual files in small reviewable commits.
- `npm run quality:check`: CI gate; ESLint runs with TypeScript project service,
  then Prettier checks every typed target. No newly introduced rule counts or
  changed/new unformatted files are accepted. Parser errors are never baselined.
  CI compares the committed baseline with the previous branch/base commit
  and rejects an increase in lint counts or new formatting fingerprints.
- `npm run quality:baseline`: explicit debt snapshot update, for reviewed
  reductions only. Never run in CI.

## Initial debt and scope

At TS6.1 start, ESLint reports 2,216 findings across 131 TypeScript files and
Prettier reports 130 unformatted files. `quality/baseline.json` records counts
by file and rule and SHA-256 fingerprints of unformatted files. These are
existing findings, not an assertion of zero lint violations. Rule counts do not
track individual finding identity; review diffs for substitutions within a file.
After reducing debt, update the baseline explicitly and review the diff.
Do not raise counts, add blanket suppressions or weaken strictness to pass CI.

The pinned dev dependencies use ESLint 10, typescript-eslint 8 and Prettier 3.
The dependency audit reports a moderate minimatch advisory in the lint-only
dependency tree; it is outside the production image and production audit
is clean. Track a compatible upstream patch; do not override a major-version
dependency or force an unrelated downgrade without testing.

CI runs the quality gate, compiler, Node/MySQL regression, Chromium and
Go checks on the TS6 branch. The release verification workflow still tests
fresh Docker setup, persistence, real Go Worker integration and image scans.
