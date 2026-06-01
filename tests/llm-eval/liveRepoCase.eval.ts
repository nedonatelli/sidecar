/**
 * Live-repo shadow eval — runs the agent against actual SideCar source files.
 *
 * This is the equivalent of the shadow workspace feature: real files are
 * materialized into a temp directory, the agent runs against them, and we
 * inspect the diff to see what changed.
 *
 * Task: extend `extractTestFiles` in completionGate.ts to recognise Rust
 * integration tests (`tests/*.rs`, `tests/**\/*.rs`).
 *
 * Run: SIDECAR_EVAL_MODEL=qwen3:8b npm run eval:llm
 * (or any other model via SIDECAR_EVAL_MODEL / SIDECAR_EVAL_BACKEND)
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { describe, it, expect } from 'vitest';
import { runAgentCase, pickAgentBackend } from './agentHarness.js';
import { renderAgentReport } from './agentScorers.js';
import type { AgentCaseResult } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Load the real files from the repo as fixtures.
// ---------------------------------------------------------------------------

function readRepoFile(rel: string): string {
  const abs = nodePath.join(import.meta.dirname, '../../', rel);
  return nodeFs.readFileSync(abs, 'utf-8');
}

// Use the pre-polyglot-change snapshot (commit bbb47a5) so the eval
// fixture is always in the "before" state regardless of what's on disk.
// Reading from disk would make the case trivially pass after we applied
// the changes — the model would have nothing to add.
const GATE_SRC = nodeFs.readFileSync(
  nodePath.join(import.meta.dirname, '../../', 'tests/llm-eval/fixtures/completionGate.pre-polyglot.ts'),
  'utf-8',
);
const GATE_TEST = nodeFs.readFileSync(
  nodePath.join(import.meta.dirname, '../../', 'tests/llm-eval/fixtures/completionGate.pre-polyglot.test.ts'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// The eval case.
// ---------------------------------------------------------------------------

const LIVE_CASE = {
  id: 'live-repo-polyglot-lint-detection',
  description:
    'Agent extends completionGate lint detection to cover Python and Go linters, with tests',
  tags: ['live-repo', 'real-files', 'shadow-workspace', 'multi-file'],
  workspace: {
    'src/agent/completionGate.ts': GATE_SRC,
    'src/agent/completionGate.test.ts': GATE_TEST,
    // Use a test command that always exits 0 so the completion gate's
    // 'run tests' requirement can be satisfied in the eval sandbox
    // (no node_modules available). The gate then advances to fire the
    // testNotUpdated check and prompt the model to add test cases.
    'package.json': JSON.stringify(
      {
        name: 'sidecar-ai',
        scripts: {
          test: 'node -e "console.log(\'Tests passed (sandbox mode)\'); process.exit(0)"',
        },
      },
      null,
      2,
    ),
  },
  // Note: warm-start experiments (list_dir, edit workflow, simple text) all
  // hurt gemma4's performance on this task. Any prior context pushes the model
  // into chat-response mode rather than tool-use mode. Cold start (direct task
  // as first message) is counter-intuitively better for gemma4:e4b here.
  // Real multi-file challenge:
  //   1. Read completionGate.ts — understand where lintObserved is set
  //   2. Extend the lint detection regex to cover Python (pylint, flake8, mypy, ruff)
  //      and Go (go vet, golangci-lint, staticcheck) tools
  //   3. Update the comment to document the new tools
  //   4. Read completionGate.test.ts — understand the test pattern
  //   5. Add at least two new test cases (one Python, one Go) following the existing style
  //   6. Do not break any existing behaviour
  userMessage:
    'Read `src/agent/completionGate.ts`. The `recordToolCall` function sets `lintObserved=true` ' +
    'when a `run_command` contains `eslint` or `tsc`. ' +
    'Extend it to also recognise Python linters (`pylint`, `flake8`, `mypy`, `ruff`, `black`) ' +
    'and Go linters (`go vet`, `golangci-lint`, `staticcheck`). ' +
    'Update the comment above the lint-detection block to document the new tools. ' +
    'Then read `src/agent/completionGate.test.ts` and add at least two new test cases — ' +
    'one for a Python linter and one for a Go linter — following the existing test style. ' +
    'Run the tests when you are done to verify nothing is broken.',
  maxIterations: 12,
  expect: {
    toolsCalled: ['read_file', 'edit_file'],
    trajectoryOrder: [{ before: 'read_file', after: 'edit_file' }],
    files: {
      // Implementation file must mention at least one Python and one Go tool
      contain: [
        { path: 'src/agent/completionGate.ts', substrings: ['pylint', 'go vet'] },
        // Test file must have new test cases
        { path: 'src/agent/completionGate.test.ts', substrings: ['pylint', 'go vet'] },
      ],
      notContain: [
        { path: 'src/agent/completionGate.ts', substrings: ['TODO', 'FIXME'] },
        { path: 'src/agent/completionGate.test.ts', substrings: ['TODO', 'FIXME'] },
      ],
    },
  },
  softExpect: {
    // Ideal: the agent also ran the tests and they passed
    toolsCalled: ['run_command'],
    files: {
      // More complete coverage
      contain: [
        { path: 'src/agent/completionGate.ts', substrings: ['flake8', 'mypy', 'golangci-lint'] },
      ],
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Plan-mode variant — tests whether gemma4 can produce a comprehensive plan
// before executing. The hypothesis: giving the model a planning turn first
// lets it internalize the full task before any tool calls, then the plan
// in context guides execution.
// ---------------------------------------------------------------------------

const PLAN_CASE = {
  id: 'live-repo-polyglot-plan-mode',
  description: 'Agent plans the polyglot-lint change in plan mode — verifies plan covers all steps',
  tags: ['live-repo', 'plan-mode', 'gemma4'],
  workspace: {
    'src/agent/completionGate.ts': GATE_SRC,
    'src/agent/completionGate.test.ts': GATE_TEST,
    'package.json': JSON.stringify(
      { name: 'sidecar-ai', scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    ),
  },
  approvalMode: 'plan' as const,
  userMessage: LIVE_CASE.userMessage,
  maxIterations: 4,
  // In plan mode the model outputs text only (no tool calls) — we check
  // the plan text covers the key steps.
  expect: {
    toolsCalled: [] as string[],
    finalTextContains: ['pylint', 'go vet', 'test'],
  },
  softExpect: {
    finalTextContains: [
      'flake8', 'golangci-lint', 'completionGate.test.ts', 'completionGate.ts',
    ],
  },
} as const;

// ---------------------------------------------------------------------------
// Runner — mirrors the pattern in agent.eval.ts.
// ---------------------------------------------------------------------------

const backend = pickAgentBackend();

// Apply the same SIDECAR_EVAL_CASE filter as agent.eval.ts so this file
// doesn't run when a different case subset is requested.
const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());
const caseMatchesFilter =
  !CASE_FILTER ||
  CASE_FILTER.some((f) => LIVE_CASE.id.includes(f) || PLAN_CASE.id.includes(f));

describe.skipIf(!backend || !caseMatchesFilter)('llm-eval :: live repo (shadow workspace)', () => {
  const allResults: AgentCaseResult[] = [];

  it(`${LIVE_CASE.id} — ${LIVE_CASE.description}`, async () => {
    const b = backend!;
    const result = await runAgentCase(LIVE_CASE as never, b);
    allResults.push(result);

    if (!result.passed) {
      // Print the diff of what changed for debugging.
      const before = LIVE_CASE.workspace['src/agent/completionGate.ts'];
      const after = result.workspaceAfter['src/agent/completionGate.ts'] ?? before;
      if (after !== before) {
        console.log('\n=== AGENT MADE THESE CHANGES ===\n');
        // Simple line-level diff for readability.
        const beforeLines = before.split('\n');
        const afterLines = after.split('\n');
        const maxLen = Math.max(beforeLines.length, afterLines.length);
        for (let i = 0; i < maxLen; i++) {
          if (beforeLines[i] !== afterLines[i]) {
            if (beforeLines[i] !== undefined) console.log(`- ${beforeLines[i]}`);
            if (afterLines[i] !== undefined) console.log(`+ ${afterLines[i]}`);
          }
        }
        console.log('\n================================\n');
      } else {
        console.log('\n(Agent made no changes to the file)\n');
      }

      const report = renderAgentReport(allResults);
      throw new Error(report);
    }

    // Print what the agent changed even on success.
    const before = LIVE_CASE.workspace['src/agent/completionGate.ts'];
    const after = result.workspaceAfter['src/agent/completionGate.ts'] ?? before;
    if (after !== before) {
      console.log('\n=== AGENT CHANGES (passed) ===\n');
      const beforeLines = before.split('\n');
      const afterLines = after.split('\n');
      const maxLen = Math.max(beforeLines.length, afterLines.length);
      for (let i = 0; i < maxLen; i++) {
        if (beforeLines[i] !== afterLines[i]) {
          if (beforeLines[i] !== undefined) console.log(`- ${beforeLines[i]}`);
          if (afterLines[i] !== undefined) console.log(`+ ${afterLines[i]}`);
        }
      }
      console.log('\n==============================\n');
    }
  });

  // Plan-mode variant: does gemma4 generate a plan that covers all required steps?
  const planMatchesFilter = !CASE_FILTER || CASE_FILTER.some((f) => PLAN_CASE.id.includes(f));
  it.skipIf(!planMatchesFilter)(
    `${PLAN_CASE.id} — ${PLAN_CASE.description}`,
    async () => {
      const b = backend!;
      const result = await runAgentCase(PLAN_CASE as never, b);
      allResults.push(result);

      console.log('\n=== GEMMA4 PLAN ===\n');
      console.log(result.finalText);
      console.log('\n===================\n');

      if (!result.passed) {
        const report = renderAgentReport(allResults);
        throw new Error(report);
      }
    },
  );
});
