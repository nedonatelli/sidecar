/**
 * Live-repo shadow eval — runs the agent against actual SideCar source files.
 *
 * The REAL development loop test: give the agent a genuine coding task on
 * SideCar's own source code and see if it completes it end-to-end.
 *
 * Current task: improve next-step suggestion strings in finalize.ts to
 * include numeric counts (error count, files-written count) instead of
 * generic boolean-driven messages.
 *
 * Run: SIDECAR_EVAL_MODEL=qwen3.5:latest npm run eval:llm
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { describe, it } from 'vitest';
import { runAgentCase, pickAgentBackend } from './agentHarness.js';
import { renderAgentReport } from './agentScorers.js';
import type { AgentCaseResult } from './agentTypes.js';

// ---------------------------------------------------------------------------
// The eval case.
// ---------------------------------------------------------------------------

const SRC = (rel: string): string =>
  nodeFs.readFileSync(nodePath.join(import.meta.dirname, '../../src', rel), 'utf-8');

const LIVE_CASE = {
  id: 'live-repo-finalize-counted-suggestions',
  description: 'Agent replaces boolean flags with numeric counters in generateNextStepSuggestions',
  tags: ['live-repo', 'real-files', 'dev-loop'],
  workspace: {
    'src/agent/loop/finalize.ts': SRC('agent/loop/finalize.ts'),
    'src/agent/loop/finalize.test.ts': SRC('agent/loop/finalize.test.ts'),
    'package.json': JSON.stringify(
      { name: 'sidecar-ai', scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    ),
  },
  // Real dev-loop task: make next-step suggestion strings more actionable.
  //
  // The private `generateNextStepSuggestions` helper in finalize.ts tracks
  // `hadErrors` (boolean) and `wroteFiles` (boolean). Both are used in
  // suggestion strings that don't tell the developer HOW MANY errors occurred
  // or HOW MANY files were written. Replace each boolean with a numeric counter
  // and interpolate the count into the strings.
  userMessage:
    'Read `src/agent/loop/finalize.ts`. ' +
    'The private `generateNextStepSuggestions` function tracks `hadErrors` as a boolean ' +
    'and `wroteFiles` as a boolean. Both produce vague generic suggestion strings. ' +
    'Make two changes: ' +
    '(1) Replace `hadErrors` with a numeric `errorCount` — increment it for each `is_error` tool result — ' +
    'and update the suggestion to include the count, e.g. "2 tool calls failed — Review errors and retry". ' +
    'The test in `finalize.test.ts` checks for the substring \'Review errors\' (capital R) so keep those words in the message. ' +
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
      // Ideal: the suggestion strings use template-literal interpolation of the counters.
      matchesRegex: [
        {
          path: 'src/agent/loop/finalize.ts',
          patterns: [/\$\{errorCount\}/, /\$\{filesWritten\}/],
        },
      ],
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Plan-mode variant — tests whether the model can produce a precise plan
// before touching any files.
// ---------------------------------------------------------------------------

const PLAN_CASE = {
  id: 'live-repo-finalize-plan-mode',
  description: 'Agent plans the finalize.ts counter refactor in plan mode',
  tags: ['live-repo', 'plan-mode'],
  workspace: {
    'src/agent/loop/finalize.ts': LIVE_CASE.workspace['src/agent/loop/finalize.ts'],
    'package.json': LIVE_CASE.workspace['package.json'],
  },
  approvalMode: 'plan' as const,
  userMessage: LIVE_CASE.userMessage,
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
// Runner — mirrors the pattern in agent.eval.ts.
// ---------------------------------------------------------------------------

const backend = pickAgentBackend();

const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());
const caseMatchesFilter =
  !CASE_FILTER ||
  CASE_FILTER.some((f) => LIVE_CASE.id.includes(f) || PLAN_CASE.id.includes(f));

describe.skipIf(!backend || !caseMatchesFilter)('llm-eval :: live repo (finalize counted suggestions)', () => {
  const allResults: AgentCaseResult[] = [];

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

      throw new Error(renderAgentReport(allResults));
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
  it.skipIf(!planMatchesFilter)(
    `${PLAN_CASE.id} — ${PLAN_CASE.description}`,
    async () => {
      const b = backend!;
      const result = await runAgentCase(PLAN_CASE as never, b);
      allResults.push(result);

      console.log('\n=== PLAN OUTPUT ===\n');
      console.log(result.finalText);
      console.log('\n===================\n');

      if (!result.passed) {
        throw new Error(renderAgentReport(allResults));
      }
    },
  );
});
