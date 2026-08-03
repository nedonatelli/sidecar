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

export default defineConfig({
  files: 'out/src/test/integration/**/*.test.js',
  extensionDevelopmentPath: '.',
  workspaceFolder: '.',
  mocha: {
    timeout: 30000,
  },
});
