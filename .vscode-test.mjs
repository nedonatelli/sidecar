import { defineConfig } from '@vscode/test-cli';
import { assertFreshBuild } from './scripts/lib/buildFreshness.mjs';

// Refuse before VS Code launches, not after the suite passes.
//
// `npm run test:integration` rebuilds first, but this config is what
// `npx vscode-test` and the VS Code test runner load directly, and neither goes
// through the npm script. The check lives here because this file is read from
// source and never compiled — it cannot itself be the stale thing.
//
// Top-level await: a throw here aborts the run with the message, which is the
// point. A stale build otherwise passes identically to a fresh one.
await assertFreshBuild(process.cwd());

// The VS Code build the suites run against. Unpinned, test-cli downloads the
// newest stable, so a VS Code release could change the environment between two
// runs of the same commit (#226: on 1.142.0 the TypeScript warm-up timed out
// twice on Oct 19, then passed 5 of 5 on Oct 21). Move it up deliberately, with
// a run, and keep it near the current stable so the suite tests what users run.
const VSCODE_VERSION = '1.142.0';

export default defineConfig([
  {
    label: 'workspace',
    files: 'out/src/test/integration/**/*.test.js',
    version: VSCODE_VERSION,
    extensionDevelopmentPath: '.',
    workspaceFolder: '.',
    mocha: {
      timeout: 30000,
    },
  },
  {
    // No workspaceFolder: a window with nothing open, where activation used
    // to fail outright (#142). Its tests use the .etest suffix so the
    // workspace run above does not pick them up.
    label: 'empty-window',
    files: 'out/src/test/integration/**/*.etest.js',
    version: VSCODE_VERSION,
    extensionDevelopmentPath: '.',
    mocha: {
      timeout: 30000,
    },
  },
]);
