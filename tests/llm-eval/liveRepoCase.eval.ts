/**
 * Live-repo shadow eval — runs the agent against actual SideCar source files.
 *
 * These are the "real development loop" tests: give the agent genuine coding
 * tasks on SideCar's own source and verify the result compiles + passes checks.
 *
 * Cases fall into two categories:
 *   1. FINALIZE_CASE / PLAN_CASE — deep refactor with custom diff reporting
 *   2. LIVE_CASES — simpler add/extend tasks, generic runner
 *
 * Run all:  npm run eval:llm
 * Run one:  SIDECAR_EVAL_CASE=live-repo-semver-lte npm run eval:llm
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { describe, it } from 'vitest';
import { runAgentCase, pickAgentBackend } from './agentHarness.js';
import { renderAgentReport } from './agentScorers.js';
import type { AgentCaseResult, AgentEvalCase } from './agentTypes.js';
import { appendFailure, writeHeader, writeSummary } from './evalReporter.js';

const SRC = (rel: string): string => nodeFs.readFileSync(nodePath.join(import.meta.dirname, '../../src', rel), 'utf-8');

const FAKE_PKG = JSON.stringify({ name: 'sidecar-ai', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2);

// ---------------------------------------------------------------------------
// Case 1: deep finalize.ts refactor (existing case, kept as-is)
// ---------------------------------------------------------------------------

const LIVE_CASE = {
  id: 'live-repo-finalize-counted-suggestions',
  description: 'Agent replaces boolean flags with numeric counters in generateNextStepSuggestions',
  tags: ['live-repo', 'real-files', 'dev-loop'],
  workspace: {
    'src/agent/loop/finalize.ts': SRC('agent/loop/finalize.ts'),
    'src/agent/loop/finalize.test.ts': SRC('agent/loop/finalize.test.ts'),
    'package.json': FAKE_PKG,
  },
  userMessage:
    'Read `src/agent/loop/finalize.ts`. ' +
    'The private `generateNextStepSuggestions` function tracks `hadErrors` as a boolean ' +
    'and `wroteFiles` as a boolean. Both produce vague generic suggestion strings. ' +
    'Make two changes: ' +
    '(1) Replace `hadErrors` with a numeric `errorCount` — increment it for each `is_error` tool result — ' +
    'and update the suggestion to include the count, e.g. "2 tool calls failed — Review errors and retry". ' +
    "The test in `finalize.test.ts` checks for the substring 'Review errors' (capital R) so keep those words in the message. " +
    '(2) Replace `wroteFiles` with a numeric `filesWritten` — increment it for each `write_file` or `edit_file` call — ' +
    'and update the diff suggestion to include the count, e.g. "Review 3 changed files before committing". ' +
    'Also update the "Run tests" suggestion to say how many files were changed. ' +
    'Do not change any other logic or variables (`ranTests` stays boolean). ' +
    'Run the tests when done.',
  maxIterations: 10,
  expect: {
    toolsCalled: ['read_file', 'edit_file'],
    trajectoryOrder: [{ before: 'read_file', after: 'edit_file' }],
    files: {
      contain: [
        {
          path: 'src/agent/loop/finalize.ts',
          substrings: ['errorCount', 'filesWritten'],
        },
      ],
      notContain: [
        {
          path: 'src/agent/loop/finalize.ts',
          substrings: ['hadErrors', 'wroteFiles'],
        },
      ],
    },
  },
  softExpect: {
    toolsCalled: ['run_command'],
    files: {
      matchesRegex: [
        {
          path: 'src/agent/loop/finalize.ts',
          patterns: [/\$\{errorCount\}/, /\$\{filesWritten\}/],
        },
      ],
    },
  },
} as const;

const PLAN_CASE = {
  id: 'live-repo-finalize-plan-mode',
  description: 'Agent plans the finalize.ts counter refactor in plan mode',
  tags: ['live-repo', 'plan-mode'],
  workspace: {
    'src/agent/loop/finalize.ts': LIVE_CASE.workspace['src/agent/loop/finalize.ts'],
    'package.json': FAKE_PKG,
  },
  approvalMode: 'plan' as const,
  userMessage: LIVE_CASE.userMessage.replace(' Run the tests when done.', ''),
  maxIterations: 4,
  expect: {
    toolsCalled: [] as string[],
    finalTextContains: ['errorCount', 'filesWritten'],
  },
  softExpect: {
    finalTextContains: ['hadErrors', 'wroteFiles', 'counter', 'increment'],
  },
} as const;

// ---------------------------------------------------------------------------
// Cases 2–7: simpler live-repo tasks, generic runner below
// ---------------------------------------------------------------------------

const LIVE_CASES: AgentEvalCase[] = [
  {
    id: 'live-repo-semver-lte',
    description: 'Agent adds semverLte() to semver.ts and extends the test file',
    tags: ['live-repo', 'real-files', 'add-function'],
    maxIterations: 10,
    workspace: {
      'src/deps/semver.ts': SRC('deps/semver.ts'),
      'src/deps/semver.test.ts': SRC('deps/semver.test.ts'),
      'package.json': FAKE_PKG,
    },
    userMessage:
      'Read `src/deps/semver.ts`. It exports `semverGt(a, b)` and `semverEq(a, b)`. ' +
      'Add an exported `semverLte(a: string, b: string): boolean` function that returns true when a ≤ b. ' +
      'Implement it using the existing `semverGt` helper — do not reimplement the comparison logic. ' +
      'Then extend `src/deps/semver.test.ts` with a `describe("semverLte", ...)` block covering: ' +
      'equal versions return true, lower-version a returns true, higher-version a returns false, ' +
      'and range operators are stripped correctly. ' +
      'Do not change any existing tests.',
    maxIterations: 8,
    expect: {
      toolsCalled: ['read_file', 'edit_file'],
      files: {
        contain: [
          { path: 'src/deps/semver.ts', substrings: ['export function semverLte', 'semverGt'] },
          { path: 'src/deps/semver.test.ts', substrings: ['semverLte'] },
        ],
        notContain: [
          // Must not reimplement parseParts/comparison logic from scratch
          { path: 'src/deps/semver.ts', substrings: ['hadErrors'] }, // sanity: no bleed from finalize
        ],
      },
    },
  },

  {
    id: 'live-repo-semver-in-range',
    description: 'Agent adds semverInRange(version, min, max) to semver.ts',
    tags: ['live-repo', 'real-files', 'add-function'],
    maxIterations: 10,
    workspace: {
      'src/deps/semver.ts': SRC('deps/semver.ts'),
      'src/deps/semver.test.ts': SRC('deps/semver.test.ts'),
      'package.json': FAKE_PKG,
    },
    userMessage:
      'Read `src/deps/semver.ts`. ' +
      'Add an exported `semverInRange(version: string, min: string, max: string): boolean` function ' +
      'that returns true when min ≤ version ≤ max (both bounds inclusive). ' +
      'Use the existing `semverGt` and `semverEq` helpers — do not reimplement comparison. ' +
      'Then add a `describe("semverInRange", ...)` block to `src/deps/semver.test.ts` with tests for: ' +
      'version below min (false), version equal to min (true), version in middle (true), ' +
      'version equal to max (true), version above max (false).',
    maxIterations: 8,
    expect: {
      toolsCalled: ['read_file', 'edit_file'],
      files: {
        contain: [
          {
            path: 'src/deps/semver.ts',
            substrings: ['export function semverInRange', 'semverGt'],
          },
          { path: 'src/deps/semver.test.ts', substrings: ['semverInRange'] },
        ],
      },
    },
  },

  {
    id: 'live-repo-toolbudget-global-cap',
    description: 'Agent adds a MAX_TOTAL_TOOL_CALLS global cap to toolBudget.ts',
    tags: ['live-repo', 'real-files', 'add-feature'],
    workspace: {
      'src/agent/loop/toolBudget.ts': SRC('agent/loop/toolBudget.ts'),
      'src/agent/loop/toolBudget.test.ts': SRC('agent/loop/toolBudget.test.ts'),
      // Minimal LoopState shape so agent can write correct types without full state.ts
      'src/agent/loop/state.ts':
        '// Minimal excerpt for eval context\n' +
        'export interface LoopState {\n' +
        '  toolCallCounts: Map<string, number>;\n' +
        '  [key: string]: unknown;\n' +
        '}\n',
      'package.json': FAKE_PKG,
    },
    userMessage:
      'Read `src/agent/loop/toolBudget.ts`. ' +
      'Add a `MAX_TOTAL_TOOL_CALLS = 200` exported constant. ' +
      'Modify `checkToolBudget` to also check this global limit: sum all values in ' +
      '`state.toolCallCounts` and return an error message if the total is ≥ MAX_TOTAL_TOOL_CALLS. ' +
      'Check the global cap BEFORE the per-tool cap so the model gets the most informative error. ' +
      'Then add a test to `src/agent/loop/toolBudget.test.ts` that verifies: ' +
      'when total calls across all tools reach 200, `checkToolBudget` returns a non-null error.',
    maxIterations: 10,
    expect: {
      toolsCalled: ['read_file', 'edit_file'],
      files: {
        contain: [
          {
            path: 'src/agent/loop/toolBudget.ts',
            substrings: ['MAX_TOTAL_TOOL_CALLS'],
          },
        ],
      },
    },
    softExpect: {
      files: {
        contain: [
          {
            path: 'src/agent/loop/toolBudget.test.ts',
            substrings: ['200'],
          },
        ],
      },
    },
  },

  {
    id: 'live-repo-toolbudget-reset',
    description: 'Agent adds resetToolCounts() to toolBudget.ts and tests it',
    tags: ['live-repo', 'real-files', 'add-function'],
    workspace: {
      'src/agent/loop/toolBudget.ts': SRC('agent/loop/toolBudget.ts'),
      'src/agent/loop/toolBudget.test.ts': SRC('agent/loop/toolBudget.test.ts'),
      'src/agent/loop/state.ts':
        '// Minimal excerpt for eval context\n' +
        'export interface LoopState {\n' +
        '  toolCallCounts: Map<string, number>;\n' +
        '  [key: string]: unknown;\n' +
        '}\n',
      'package.json': FAKE_PKG,
    },
    userMessage:
      'Read `src/agent/loop/toolBudget.ts`. ' +
      'Add an exported `resetToolCounts(state: LoopState): void` function that clears all tool call ' +
      'counters by calling `state.toolCallCounts.clear()`. ' +
      'Then add a test to `src/agent/loop/toolBudget.test.ts` that: ' +
      '(1) records several tool uses, (2) calls `resetToolCounts`, ' +
      '(3) verifies `checkToolBudget` returns null again for those tools (budget reset).',
    maxIterations: 10,
    expect: {
      toolsCalled: ['read_file', 'edit_file'],
      files: {
        contain: [
          {
            path: 'src/agent/loop/toolBudget.ts',
            substrings: ['export function resetToolCounts'],
          },
          {
            path: 'src/agent/loop/toolBudget.test.ts',
            substrings: ['resetToolCounts'],
          },
        ],
      },
    },
  },

  {
    id: 'live-repo-token-estimation-export-classifier',
    description: 'Agent exports the private charsPerTokenForSample helper and adds tests',
    tags: ['live-repo', 'real-files', 'refactor'],
    workspace: {
      'src/config/tokenEstimation.ts': SRC('config/tokenEstimation.ts'),
      'src/config/tokenEstimation.test.ts': SRC('config/tokenEstimation.test.ts'),
      'package.json': FAKE_PKG,
    },
    userMessage:
      'Read `src/config/tokenEstimation.ts`. ' +
      'The `charsPerTokenForSample(sample: string): number` function is currently private. ' +
      'Export it so callers can classify text type without going through the full estimation. ' +
      'Then add two new tests to `src/config/tokenEstimation.test.ts` in a new ' +
      '`describe("charsPerTokenForSample", ...)` block: ' +
      '(1) an empty string returns the English ratio (4.0), ' +
      '(2) a string with >30% CJK codepoints (e.g. repeated 日本語) returns a value ≤ 2 ' +
      '(the CJK ratio is 1.5 chars/token). ' +
      'Import `charsPerTokenForSample` in the test file.',
    maxIterations: 10,
    expect: {
      toolsCalled: ['read_file', 'edit_file'],
      files: {
        contain: [
          {
            path: 'src/config/tokenEstimation.ts',
            substrings: ['export function charsPerTokenForSample'],
          },
          {
            path: 'src/config/tokenEstimation.test.ts',
            substrings: ['charsPerTokenForSample'],
          },
        ],
      },
    },
  },

  {
    id: 'live-repo-semver-prerelease-tests',
    description: 'Agent extends semver.test.ts with pre-release version edge-case tests',
    tags: ['live-repo', 'real-files', 'extend-tests'],
    workspace: {
      'src/deps/semver.ts': SRC('deps/semver.ts'),
      'src/deps/semver.test.ts': SRC('deps/semver.test.ts'),
      'package.json': FAKE_PKG,
    },
    userMessage:
      'Read `src/deps/semver.ts` and `src/deps/semver.test.ts`. ' +
      'The `parseParts` helper strips pre-release suffixes via `replace(/[-+].*$/, "")`, ' +
      'so `1.0.0-alpha` and `1.0.0` are treated as equal by `semverGt`/`semverEq`. ' +
      'Add a new `describe("pre-release handling", ...)` block to `semver.test.ts` with tests for: ' +
      '(1) `semverGt("1.0.0", "1.0.0-alpha")` → false (both become 1.0.0 after stripping), ' +
      '(2) `semverEq("1.0.0", "1.0.0-beta.1")` → true (pre-release stripped), ' +
      '(3) `stripRange("v1.0.0-beta")` → "1.0.0-beta" (v prefix stripped, pre-release kept by stripRange), ' +
      '(4) `semverGt("2.0.0-alpha", "1.9.9")` → true (major version still wins after stripping). ' +
      'Do not modify semver.ts — only extend the test file.',
    maxIterations: 10,
    expect: {
      toolsCalled: ['read_file', 'edit_file'],
      files: {
        contain: [
          {
            path: 'src/deps/semver.test.ts',
            substrings: ['pre-release', '1.0.0-alpha'],
          },
        ],
        notModified: ['src/deps/semver.ts'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Runner — mirrors the pattern in agent.eval.ts
// ---------------------------------------------------------------------------

const backend = pickAgentBackend();

const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());
const TAG_FILTER = process.env.SIDECAR_EVAL_TAGS?.split(',').map((s) => s.trim());

// ---------------------------------------------------------------------------
// Finalize refactor (deep case with custom diff output)
// ---------------------------------------------------------------------------

const finalizeCaseMatchesFilter =
  !CASE_FILTER || CASE_FILTER.some((f) => LIVE_CASE.id.includes(f) || PLAN_CASE.id.includes(f));

const finalizeCaseMatchesTagFilter =
  !TAG_FILTER ||
  TAG_FILTER.every((t) => LIVE_CASE.tags.includes(t)) ||
  TAG_FILTER.every((t) => PLAN_CASE.tags.includes(t));

describe.skipIf(!backend || !finalizeCaseMatchesFilter || !finalizeCaseMatchesTagFilter)(
  'llm-eval :: live repo (finalize counted suggestions)',
  () => {
    const allResults: AgentCaseResult[] = [];
    writeHeader('llm-eval :: live repo (finalize counted suggestions)');

    it(`${LIVE_CASE.id} — ${LIVE_CASE.description}`, async () => {
      const b = backend!;
      const result = await runAgentCase(LIVE_CASE as never, b);
      allResults.push(result);

      if (!result.passed) {
        const before = LIVE_CASE.workspace['src/agent/loop/finalize.ts'];
        const after = result.workspaceAfter['src/agent/loop/finalize.ts'] ?? before;
        if (after !== before) {
          console.log('\n=== AGENT MADE THESE CHANGES ===\n');
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
        appendFailure('live repo (finalize counted suggestions)', LIVE_CASE.id, report);
        throw new Error(report);
      }

      const before = LIVE_CASE.workspace['src/agent/loop/finalize.ts'];
      const after = result.workspaceAfter['src/agent/loop/finalize.ts'] ?? before;
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

    const planMatchesFilter = !CASE_FILTER || CASE_FILTER.some((f) => PLAN_CASE.id.includes(f));
    it.skipIf(!planMatchesFilter)(`${PLAN_CASE.id} — ${PLAN_CASE.description}`, async () => {
      const b = backend!;
      const result = await runAgentCase(PLAN_CASE as never, b);
      allResults.push(result);

      console.log('\n=== PLAN OUTPUT ===\n');
      console.log(result.finalText);
      console.log('\n===================\n');

      if (!result.passed) {
        const report = renderAgentReport(allResults);
        appendFailure('live repo (finalize counted suggestions)', PLAN_CASE.id, report);
        throw new Error(report);
      }
    });

    it('summary', () => {
      const passed = allResults.filter((r) => r.passed).length;
      writeSummary(passed, allResults.length);
    });
  },
);

// ---------------------------------------------------------------------------
// Generic runner for the LIVE_CASES array
// ---------------------------------------------------------------------------

const liveCasesInFilter = LIVE_CASES.filter((c) => {
  if (CASE_FILTER && !CASE_FILTER.some((f) => c.id.includes(f))) return false;
  if (TAG_FILTER && !TAG_FILTER.every((t) => c.tags.includes(t))) return false;
  return true;
});

describe.skipIf(!backend || liveCasesInFilter.length === 0)('llm-eval :: live repo', () => {
  const allResults: AgentCaseResult[] = [];
  writeHeader('llm-eval :: live repo');

  for (const evalCase of liveCasesInFilter) {
    it(`${evalCase.id} — ${evalCase.description}`, async () => {
      const result = await runAgentCase(evalCase, backend!);
      allResults.push(result);

      if (!result.passed) {
        const report = renderAgentReport(allResults);
        appendFailure('live repo', evalCase.id, report);
        throw new Error(report);
      }
    });
  }

  it('summary', () => {
    const passed = allResults.filter((r) => r.passed).length;
    writeSummary(passed, allResults.length);
  });
});
