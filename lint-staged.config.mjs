// Pre-commit checks (run by .husky/pre-commit via `npx lint-staged`).
//
// TypeScript runs as ONE task group so the test suite runs ONCE per commit.
// It used to be three groups -- src/**, tests/** and bench/** -- each ending in
// its own vitest run, and lint-staged runs groups in parallel: a commit touching
// all three started two identical full suites plus the bench suite at once.
// That saturated the CPU by itself, and tests that spawn real processes (Git
// Bash, npm) then missed their timeouts, so whether a commit passed depended on
// what else the machine was doing.
//
// The tasks stay inside lint-staged (rather than a vitest call after it in the
// hook) so they check what is being committed: lint-staged hides unstaged
// changes while its tasks run.
import path from 'node:path';

const quote = (file) => `"${file}"`;
const area = (file) => path.relative(process.cwd(), file).split(path.sep)[0];

// Each area's type-check project, run only when that area has staged files.
const TSC = {
  src: 'tsc --noEmit',
  tests: 'tsc -p tsconfig.tests.json',
  bench: 'tsc -p tsconfig.bench.json',
};

const FULL_SUITE = 'vitest run --silent --exclude "**/shadowWorkspace.test.ts" --exclude "**/shadowSweep.test.ts"';
// bench/ tests are part of the full suite; a bench-only commit runs just them.
const BENCH_SUITE = 'vitest run bench/ --silent';

export default {
  '{src,tests,bench}/**/*.ts': (files) => {
    const list = files.map(quote).join(' ');
    const areas = new Set(files.map(area));
    return [
      `prettier --write ${list}`,
      `eslint --max-warnings=0 --no-warn-ignored ${list}`,
      ...Object.keys(TSC)
        .filter((a) => areas.has(a))
        .map((a) => `bash -c '${TSC[a]}'`),
      `bash -c '${areas.size === 1 && areas.has('bench') ? BENCH_SUITE : FULL_SUITE}'`,
    ];
  },
  'media/**/*.css': ['prettier --write'],
  'media/**/*.js': ['prettier --write', 'eslint --max-warnings=0'],
  'scripts/**/*.mjs': ['prettier --write', 'eslint --max-warnings=0'],
  '**/*.{md,json}': ['prettier --write'],
};
