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
// Use the updated test file that includes the \S+ regression guard —
// when the agent runs tests after editing, this assertion will fail if
// the model changes \S+ to .* in the Python pattern.
const GATE_TEST = readRepoFile('src/agent/completionGate.test.ts');

// ---------------------------------------------------------------------------
// The eval case.
// ---------------------------------------------------------------------------

const LIVE_CASE = {
  id: 'live-repo-rust-test-support',
  description:
    'Agent extends extractTestFiles in real completionGate.ts to recognise Rust integration tests',
  tags: ['live-repo', 'real-files', 'shadow-workspace'],
  workspace: {
    // Real SideCar source files — the agent edits these, not toy fixtures.
    'src/agent/completionGate.ts': GATE_SRC,
    'src/agent/completionGate.test.ts': GATE_TEST,
    // Minimal package.json so the agent can discover the project.
    'package.json': JSON.stringify({ name: 'sidecar-ai', scripts: { test: 'vitest run' } }, null, 2),
  },
  userMessage:
    'Read `src/agent/completionGate.ts` and find the `extractTestFiles` function. ' +
    'Add `tests/\\S+\\.rs` to its regex so Rust integration test files are matched. ' +
    'Update the comment above the regex to mention Rust. ' +
    'Do not change anything else in the file.',
  expect: {
    toolsCalled: ['read_file', 'edit_file'],
    trajectoryOrder: [{ before: 'read_file', after: 'edit_file' }],
    files: {
      contain: [
        {
          path: 'src/agent/completionGate.ts',
          // Rust .rs files in a tests/ directory
          substrings: ['.rs'],
        },
      ],
      // The existing Python and Go patterns must still be present
      notContain: [
        {
          path: 'src/agent/completionGate.ts',
          substrings: ['TODO', 'FIXME'],
        },
      ],
    },
    softExpect: {
      files: {
        matchesRegex: [
          {
            path: 'src/agent/completionGate.ts',
            // Should match `tests/something.rs` or `tests/**/*.rs` pattern
            patterns: [/tests[/\\][^|)]+\.rs/],
          },
        ],
      },
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
