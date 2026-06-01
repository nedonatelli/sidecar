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

const GATE_SRC = readRepoFile('src/agent/completionGate.ts');
const GATE_TEST = readRepoFile('src/agent/completionGate.test.ts');

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
    'package.json': JSON.stringify({ name: 'sidecar-ai', scripts: { test: 'vitest run' } }, null, 2),
  },
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
// Runner — mirrors the pattern in agent.eval.ts.
// ---------------------------------------------------------------------------

const backend = pickAgentBackend();

// Apply the same SIDECAR_EVAL_CASE filter as agent.eval.ts so this file
// doesn't run when a different case subset is requested.
const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());
const caseMatchesFilter = !CASE_FILTER || CASE_FILTER.some((f) => LIVE_CASE.id.includes(f));

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
});
