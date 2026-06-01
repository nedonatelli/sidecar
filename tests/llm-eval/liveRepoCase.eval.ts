/**
 * Live-repo shadow eval — runs the agent against actual SideCar source files.
 *
 * The REAL development loop test: give the agent a genuine coding task on
 * SideCar's own source code and see if it completes it end-to-end.
 *
 * Current task: improve cycle detector stop messages to include tool name
 * and resource so developers can debug stuck agents.
 *
 * Run: SIDECAR_EVAL_MODEL=qwen3.5:latest npm run eval:llm
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { describe, it, expect } from 'vitest';
import { runAgentCase, pickAgentBackend } from './agentHarness.js';
import { renderAgentReport } from './agentScorers.js';
import type { AgentCaseResult } from './agentTypes.js';

// ---------------------------------------------------------------------------
// The eval case.
// ---------------------------------------------------------------------------

const LIVE_CASE = {
  id: 'live-repo-cycle-detector-messages',
  description:
    'Agent improves cycle detector stop messages to include tool name and resource for debugging',
  tags: ['live-repo', 'real-files', 'shadow-workspace', 'dev-loop'],
  workspace: {
    'src/agent/loop/cycleDetection.ts': nodeFs.readFileSync(
      nodePath.join(import.meta.dirname, '../../src/agent/loop/cycleDetection.ts'),
      'utf-8',
    ),
    'src/agent/loop/cycleDetection.test.ts': nodeFs.readFileSync(
      nodePath.join(import.meta.dirname, '../../src/agent/loop/cycleDetection.test.ts'),
      'utf-8',
    ),
    'package.json': JSON.stringify(
      { name: 'sidecar-ai', scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    ),
  },
  // Real dev-loop task: improve debugging UX in cycleDetection.ts.
  // The stop messages currently say "same tool call repeated N times" without
  // naming which tool or resource was stuck. A developer can't tell what happened.
  // Fix: include the tool name and resource in each stop message.
  userMessage:
    'Read `src/agent/loop/cycleDetection.ts`. ' +
    'The user-visible stop messages (the strings passed to `callbacks.onText`) say things like ' +
    '"same tool call repeated 4 times in a row" but don\'t mention which tool was stuck or on which file. ' +
    'Edit the messages so they include the tool name and resource — e.g. ' +
    '"read_file on src/foo.ts repeated 4 times in a row". ' +
    'The `callSignature` variable contains `name:input` — parse the tool name from it. ' +
    'The `normEntry.sig` variable contains `tool:resource` — use it for the normalized messages. ' +
    'Do not change any logic, only the message strings. ' +
    'Run the tests when done.',
  maxIterations: 10,
  expect: {
    toolsCalled: ['read_file', 'edit_file'],
    trajectoryOrder: [{ before: 'read_file', after: 'edit_file' }],
    files: {
      // The original message was: "same tool call repeated 4 times in a row"
      // After the fix it should include a variable — so the static string must be gone
      // and replaced with something that interpolates the tool name.
      notContain: [
        {
          path: 'src/agent/loop/cycleDetection.ts',
          // Original verbatim string — should no longer exist after the fix
          substrings: ['same tool call repeated ${MIN_IDENTICAL_REPEATS} times in a row'],
        },
      ],
    },
  },
  softExpect: {
    toolsCalled: ['run_command'],
    files: {
      // Ideal: stop messages include a variable reference to show the tool/resource
      matchesRegex: [
        {
          path: 'src/agent/loop/cycleDetection.ts',
          // Message now includes a dynamic tool/resource reference
          patterns: [/Agent stopped.*\$\{.*\}.*repeated|callSignature.*split|normEntry\.sig.*repeated/],
        },
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
  id: 'live-repo-cycle-detector-plan-mode',
  description: 'Agent plans the cycle detector message improvement in plan mode',
  tags: ['live-repo', 'plan-mode'],
  workspace: {
    'src/agent/loop/cycleDetection.ts': LIVE_CASE.workspace['src/agent/loop/cycleDetection.ts'],
    'package.json': JSON.stringify(
      { name: 'sidecar-ai', scripts: { test: 'node -e "process.exit(0)"' } },
      null,
      2,
    ),
  },
  approvalMode: 'plan' as const,
  userMessage: LIVE_CASE.userMessage,
  maxIterations: 4,
  expect: {
    toolsCalled: [] as string[],
    finalTextContains: ['callSignature', 'onText'],
  },
  softExpect: {
    finalTextContains: ['normEntry', 'tool name', 'resource'],
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
      const before = LIVE_CASE.workspace['src/agent/loop/cycleDetection.ts'];
      const after = result.workspaceAfter['src/agent/loop/cycleDetection.ts'] ?? before;
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
    const before = LIVE_CASE.workspace['src/agent/loop/cycleDetection.ts'];
    const after = result.workspaceAfter['src/agent/loop/cycleDetection.ts'] ?? before;
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
