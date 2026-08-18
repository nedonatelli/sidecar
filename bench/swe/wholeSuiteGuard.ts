// ---------------------------------------------------------------------------
// Test-invocation guard for SWE-bench arms.
//
// Two ways the agent's verification channel breaks, both observed 2026-08-18 on
// gemma4:e4b, both leaving it with no usable signal about its own fix:
//
//   1. NO LABEL. The prompt asked for `<test_cmd> <test module or path>`; the
//      model dropped the placeholder and ran the bare command, which for django
//      is the ENTIRE suite. Three identical invocations in one arm, each killed
//      at the old 120s ceiling — 67% of that arm's wall clock, all of it
//      returning truncated output.
//   2. BAD LABEL. After the prompt was tightened it scoped correctly in spirit
//      but used a path (`tests/file_uploads/`); django derived
//      `file_uploads.tests`, which failed to import. Four identical retries,
//      zero tests run. Cheap in wall clock (3s) and just as useless.
//
// Case 2 is why this checks tool RESULTS and not only commands: a scoped-looking
// command that ran nothing is indistinguishable from a good one at the call site.
//
// Both fire on `afterToolResults` — the earliest phase that can see either the
// command or its output, since there is no pre-execution hook — so the FIRST
// offence is still paid for. What the guard prevents is the repeats.
//
// Deliberately does NOT name the gold tests: `FAIL_TO_PASS` is not shown to
// agents, so the reprompts teach the *shape* of a scoped command and leave the
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

/**
 * Output signatures meaning the runner rejected the LABEL, not that tests failed.
 * An ordinary assertion failure must not match — that is a real result the agent
 * needs to act on, and nagging about it would be worse than silence.
 */
const BAD_LABEL_SIGNATURES = [
  /unittest\.loader\._FailedTest/,
  /Failed to import test module/i,
  /ModuleNotFoundError/,
  /\bERROR: not found:/,
  /no tests ran/i,
  // django prints `Ran 0 tests ... OK` for a label that resolves to a module
  // with no tests — not an error, and it READS like success. Seven of these in
  // one run went unnoticed because the guard only looked for error text.
  /\bRan 0 tests?\b/,
  /file or directory not found/i,
];

/**
 * True when a test run failed because the label could not be resolved. Checked
 * against the tool RESULT, so it catches the case a bare-invocation check cannot:
 * the agent scoped correctly in spirit but used a form the runner rejects.
 */
export function isBadTestLabelOutput(output: string): boolean {
  return BAD_LABEL_SIGNATURES.some((re) => re.test(output));
}

const BARE_SUITE_REPROMPT =
  'STOP — that command ran the **entire test suite**, not the tests for this issue.\n\n' +
  'A bare runner invocation executes thousands of tests. It takes many minutes and its output is ' +
  'truncated before you can read the part you need, so it cannot tell you whether your fix worked.\n\n' +
  'Re-run it scoped to the specific test module for this issue by appending a test label, e.g. ' +
  '`<the test command> some_module` or `<the test command> some_module.test_file`.\n\n' +
  'Pick the module that covers the code you changed — infer it from the issue text and the file you edited. ' +
  'Never run the bare command again in this task.';

const BAD_LABEL_REPROMPT =
  'STOP — that test run executed NO tests, so you have learned nothing about your fix. ' +
  'The **test label** was either rejected by the runner or resolved to something containing no tests. ' +
  'Note that `Ran 0 tests ... OK` is a failure here, not a pass.\n\n' +
  'A test label names a TEST module, not the source module you edited:\n' +
  '  correct:   `file_uploads`   `auth_tests`   `utils_tests.test_autoreload`\n' +
  '  incorrect: `django.core.files.uploadedfile`  (a source path — runs zero tests)\n' +
  '  incorrect: `tests/file_uploads/`  `tests/file_uploads/tests.py`  (filesystem paths)\n\n' +
  'Pick from the test modules listed in your task instructions. Do not re-run the same label — ' +
  'it will behave identically.';

/**
 * Deterministic guard: reprompt once when the agent runs a whole project suite.
 *
 * Once-per-run by construction. A guard that can fire repeatedly turns into its
 * own cycle, and the loop already has enough ways to spend turns.
 */
export function wholeSuiteGuard(): PolicyHook {
  // Independent one-shot latches. Each failure mode gets exactly one nudge: a
  // guard that can re-fire becomes its own cycle, and the loop already has
  // enough ways to spend turns. Independent because they are different mistakes
  // and hitting one should not silence the other.
  let firedBareSuite = false;
  let firedBadLabel = false;

  const isTestRun = (u: { name: string; input: unknown }): string | null => {
    if (u.name !== 'run_command' && u.name !== 'run_tests') return null;
    const input = u.input as { command?: unknown };
    return typeof input.command === 'string' ? input.command : null;
  };

  return {
    name: 'wholeSuiteGuard',
    async afterToolResults(state, ctx) {
      const uses = ctx.pendingToolUses;
      if (!uses || uses.length === 0) return;
      const commands = uses.map(isTestRun).filter((c): c is string => c !== null);
      if (commands.length === 0) return;

      if (!firedBareSuite && commands.some(isWholeSuiteInvocation)) {
        firedBareSuite = true;
        state.messages.push({ role: 'user', content: BARE_SUITE_REPROMPT });
        return { mutated: true, reason: 'whole-suite test invocation' };
      }

      // A scoped run whose label the runner rejected. Only meaningful when a
      // test command actually ran this turn, so an unrelated tool's error text
      // can never trip it.
      if (!firedBadLabel) {
        const output = (ctx.toolResults ?? []).map((r) => r.content).join('\n');
        if (output && isBadTestLabelOutput(output)) {
          firedBadLabel = true;
          state.messages.push({ role: 'user', content: BAD_LABEL_REPROMPT });
          return { mutated: true, reason: 'invalid test label' };
        }
      }
    },
  };
}
