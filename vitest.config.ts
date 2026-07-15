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
//
// VS Code extension lifecycle files — these are pure registration/wiring
// code that requires a running VS Code host process. All testable logic has
// been extracted into handler/service modules that ARE covered:
//   - `src/extension.ts` — extension entry point (activates subsystems)
//   - `src/webview/chatView.ts` — WebviewViewProvider (message routing);
//     handlers are in handlers/ and are unit-tested
//   - `src/activation/**` — service initialization (workspaceIndexer, MCP,
//     editor features) that calls VS Code APIs at activation time
//   - `src/ui/**` — VS Code status-bar UI
//   - `src/views/**` — VS Code tree-view providers
//   - `src/commands/**` — command registration wrappers (pure VS Code API
//     wiring; all testable logic lives in the called service modules)
const COVERAGE_THRESHOLDS = {
  statements: 70,
  branches: 63,
  functions: 67,
  lines: 71,
};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // tests/llm-eval/**/*.test.ts holds PURE unit tests of eval infrastructure
    // (verdict logic, statistics) — no model, no network — so they run in the fast
    // suite. The model-driven eval cases are *.eval.ts and run under
    // vitest.eval.config.ts instead; they are not matched here.
    // tests/llm-eval/*.test.ts (top level only — NOT fixtures/, which contains
    // polyglot test DATA named *.test.ts) holds pure unit tests of eval infra
    // (verdict logic, statistics) — no model, no network — so they run in the fast
    // suite. Model-driven eval cases are *.eval.ts under vitest.eval.config.ts.
    include: ['src/**/*.test.ts', 'bench/**/*.test.ts', 'tests/llm-eval/*.test.ts'],
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
        // VS Code extension lifecycle — requires running host process
        'src/extension.ts',
        'src/webview/chatView.ts',
        'src/activation/**',
        'src/ui/**',
        'src/views/**',
        'src/commands/**',
      ],
      thresholds: COVERAGE_THRESHOLDS,
    },
    alias: {
      vscode: new URL('./src/__mocks__/vscode.ts', import.meta.url).pathname,
    },
  },
});
