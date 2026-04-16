import { defineConfig } from 'vitest/config';

// Coverage ratchet policy — see ROADMAP.md > Coverage Plan.
//
// Thresholds are the v0.59 floor: the current measured coverage minus a
// small buffer so a flaky ±0.1 pp swing doesn't fail CI spuriously. Each
// release bumps these upward per the per-release deltas in the plan.
// Every new source file should land with ≥80% coverage by policy; the
// ratchet is the guard-rail against regressions on already-covered code.
//
// Non-behavioral code is excluded from the denominator so coverage math
// reflects actual test-worthiness rather than file-count accounting:
//   - `*/types.ts` and `*/constants.ts` are pure type/data declarations
//   - `src/__mocks__/**` is test scaffolding, not production code
//   - `chatWebview.ts` is the webview entrypoint HTML string, untestable
//   - `src/test/**` is the integration-test harness
//   - `*.d.ts` declarations
const COVERAGE_THRESHOLDS = {
  statements: 60,
  branches: 53,
  functions: 60,
  lines: 61,
};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/constants.ts',
        'src/__mocks__/**',
        'src/test/**',
        'src/webview/chatWebview.ts',
      ],
      thresholds: COVERAGE_THRESHOLDS,
    },
    alias: {
      vscode: new URL('./src/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});
