// ---------------------------------------------------------------------------
// Whole-suite guard for SWE-bench arms.
//
// The task prompt already tells the agent to run `<test_cmd> <test module or
// path>`, but gemma4:e4b dropped the placeholder and ran the bare command —
// which for django means the ENTIRE suite. Observed 2026-08-18: three identical
// bare invocations in one arm, each killed at the old 120s wall-clock ceiling,
// ~6 minutes spent returning truncated output the model could not use.
//
// Now that the shell timeout is idle-based, a bare invocation no longer gets cut
// off at 120s — it runs to completion (or the 30-minute absolute cap), so the
// same mistake costs far more. Hence a deterministic guard rather than trusting
// the prompt: the harness catches it and says so, once.
//
// Fires on `afterToolResults`, which is the earliest phase that can see the
// command (there is no pre-execution hook), so the FIRST bare run is still paid
// for. What the guard prevents is the repeats, which was most of the waste.
//
// Deliberately does NOT name the gold tests: `FAIL_TO_PASS` is not shown to
// agents, so the reprompt teaches the *shape* of a scoped command and leaves the
// choice of module to the agent.
// ---------------------------------------------------------------------------

import type { PolicyHook } from '../../src/agent/loop/policyHook.js';

/** Runner scripts whose bare invocation executes a whole project suite. */
const RUNNER_PATTERNS = [/runtests\.py\b/, /\bpytest\b/, /manage\.py\s+test\b/, /\bnose2?\b/, /\btox\b/];

/**
 * True when `command` invokes a project test runner with NO test label, i.e. it
 * will execute the entire suite.
 *
 * A "label" is any token that is not the script itself, not a flag, and not a
 * bare numeric flag value (`--verbosity 2`, `--parallel 1`). The equals form
 * (`--settings=test_sqlite`) is self-contained and reads as a flag. The
 * space-separated form (`--settings test_sqlite`) would read as a label and make
 * this return false — a deliberate false-negative: the env specs use `=`, and
 * wrongly nagging a correctly-scoped command is worse than missing one.
 */
export function isWholeSuiteInvocation(command: string): boolean {
  const cmd = command.trim();
  if (!RUNNER_PATTERNS.some((re) => re.test(cmd))) return false;

  const tokens = cmd.split(/\s+/);
  const labels = tokens.filter((t, i) => {
    if (i === 0) return false; // the interpreter or script
    if (t.startsWith('-')) return false; // any flag, incl. --settings=x and -m
    if (/^\d+(\.\d+)?$/.test(t)) return false; // numeric flag value
    if (/\.py$/.test(t) && /runtests\.py$/.test(t)) return false; // the runner script itself
    if (t === 'pytest' || t === 'test' || t === 'nose2' || t === 'tox') return false; // module name after -m
    if (/manage\.py$/.test(t)) return false;
    return true;
  });

  return labels.length === 0;
}

const REPROMPT =
  'STOP — that command ran the **entire test suite**, not the tests for this issue.\n\n' +
  'A bare runner invocation executes thousands of tests. It takes many minutes and its output is ' +
  'truncated before you can read the part you need, so it cannot tell you whether your fix worked.\n\n' +
  'Re-run it scoped to the specific test module for this issue by appending a test label, e.g.:\n' +
  '  `<the test command> some_tests.test_module`\n' +
  '  `<the test command> tests/some_tests/test_module.py`\n\n' +
  'Pick the module that covers the code you changed — infer it from the issue text and the file you edited. ' +
  'Never run the bare command again in this task.';

/**
 * Deterministic guard: reprompt once when the agent runs a whole project suite.
 *
 * Once-per-run by construction. A guard that can fire repeatedly turns into its
 * own cycle, and the loop already has enough ways to spend turns.
 */
export function wholeSuiteGuard(): PolicyHook {
  let fired = false;

  return {
    name: 'wholeSuiteGuard',
    async afterToolResults(state, ctx) {
      if (fired) return;
      const uses = ctx.pendingToolUses;
      if (!uses || uses.length === 0) return;

      const offending = uses.some((u) => {
        if (u.name !== 'run_command' && u.name !== 'run_tests') return false;
        const input = u.input as { command?: unknown };
        return typeof input.command === 'string' && isWholeSuiteInvocation(input.command);
      });
      if (!offending) return;

      fired = true;
      state.messages.push({ role: 'user', content: REPROMPT });
      return { mutated: true, reason: 'whole-suite test invocation' };
    },
  };
}
