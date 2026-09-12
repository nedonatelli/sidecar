// ---------------------------------------------------------------------------
// Repro-first guard: the discipline a small model will not impose on itself.
//
// Measured over 522 harness-scored gemma4:e4b runs (two identifier-orientation
// matrices, 2026-09-11/12), looking only at the second stage -- runs that
// EDITED a gold file and still did not resolve (279 of 353):
//
//   - 7% of runs ever wrote a test or reproduction, although the task prompt
//     asks for one in its first sentence.
//   - 28% of runs finished without running any test at all; those resolve at
//     3%, versus 17-26% for runs that ran one.
//   - 61% of the failed edits overlapped the gold hunk (+/-15 lines): right
//     file, right place, wrong change -- and 51% of them left the target tests
//     exactly as they were. The model's own test runs were GREEN for those:
//     the failing tests do not exist yet, so existing tests pass regardless of
//     the fix, and "green" resolved only 17%.
//   - 8% crashed the whole test run (a check raised where it should have
//     warned); 11 of those 22 had seen the crash in their own last run.
//
// The verification channel is structurally empty unless the model FIRST makes
// the bug observable. This hook enforces that order, deterministically:
//
//   1. Until a command has FAILED (non-zero exit, or a test run classified as
//      failing), any edit to a git-tracked non-test file is reverted and the
//      model is told to reproduce first. New files (a repro script) and test
//      files are always allowed -- they are how one reproduces.
//   2. When the model tries to finish after editing source without re-running
//      the command that demonstrated the bug, it is asked once to re-run it.
//
// afterToolResults is the earliest phase that can see an edit (there is no
// pre-execution veto for edits), so the edit lands and is then undone; the
// model pays one turn per offence. Reverts are capped: a guard that can fire
// forever is its own cycle, and the loop has enough of those.
//
// Harness-only. Never names the gold tests; the model chooses what to run.
// ---------------------------------------------------------------------------

import type { PolicyHook } from '../../src/agent/loop/policyHook.js';
import { isBadTestLabelOutput } from './wholeSuiteGuard.js';

export interface ReproFirstOptions {
  /** True when `path` is tracked in the repo at base, i.e. existing source or test. */
  isTracked: (path: string) => boolean;
  /** Restore `path` to its base content. Called for a blocked edit. */
  revert: (path: string) => void;
  /** Receives every firing as user-visible text (🛡️-prefixed, so trajectories record it). */
  onText?: (text: string) => void;
  /** Reverts after which the guard stops enforcing (default 3). */
  maxReverts?: number;
}

export interface ReproFirstStats {
  demonstrated: boolean;
  reproCommand: string | null;
  reverts: number;
  gaveUp: boolean;
  rerunPrompted: boolean;
  sourceEdits: number;
  /** "That did not demonstrate the bug" nudges sent (exit 0 / zero tests), capped. */
  nudges: number;
}

export interface ReproFirstHook extends PolicyHook {
  stats(): ReproFirstStats;
}

/** Existing test files may be edited before a repro: adding a test IS a repro. */
export function isTestPath(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return (
    /(^|\/)tests?\//.test(n) ||
    /(^|\/)test_[^/]*\.py$/.test(n) ||
    /_tests?\.py$/.test(n) ||
    /(^|\/)conftest\.py$/.test(n)
  );
}

/**
 * Did this command demonstrate a failure? `run_command` appends
 * `(exit code: N)` only when N != 0; `run_tests` output is classified the way
 * the completion gate classifies it. A run that executed zero tests is not a
 * demonstration of anything.
 */
/** Commands that can execute Python and therefore demonstrate a Python bug. */
const PYTHON_RUNNER =
  /(^|[\s;&|])(python[0-9.]*|py|pytest|py\.test|tox|nose2?)\b|runtests\.py|manage\.py|-m\s+unittest/;

export function isFailingResult(toolName: string, result: string, command?: string): boolean {
  // Only run_command can demonstrate. run_tests is hidden from the SWE
  // catalog but still executes when the model calls it from memory; in
  // django it runs `npm test`, whose `pretest` eslint fails -- the second
  // smoke credited that non-zero exit as "bug demonstrated".
  if (toolName !== 'run_command') return false;
  // And only a command that runs Python. In the first repro-on cell, 3 of 27
  // "demonstrations" were a `grep`/`rg` exiting 1 for no match.
  if (command !== undefined && !PYTHON_RUNNER.test(command)) return false;
  if (/⚠️ Command timed out/.test(result)) return false; // hung, not failed
  // A run that collected nothing (pytest exit 5, `Ran 0 tests`, a label the
  // runner rejected) is non-zero and proves nothing. Checked first.
  if (isBadTestLabelOutput(result)) return false;
  // Not end-anchored: the result arrives wrapped in <tool_output>...</tool_output>,
  // and the first smoke missed a real `(exit code: 5)` for exactly that reason.
  return /\(exit code: -?[1-9]\d*\)/.test(result);
}

/** True when the command ran nothing (pytest exit 5 / `Ran 0 tests` / rejected label). */
export function ranNothing(result: string): boolean {
  return isBadTestLabelOutput(result);
}

const NOT_A_DEMO_EXIT0 = (cmd: string): string =>
  `🛡️ \`${cmd}\` exited 0, so it did NOT demonstrate the bug -- a script that prints the wrong value ` +
  `and exits normally proves nothing. Make it FAIL on the current code: assert the behaviour the issue ` +
  `expects (\`assert actual == expected\`), or raise. If the file defines test functions or a TestCase, ` +
  `running it as a plain script executes nothing -- run it with \`python -m pytest <file>\` or add ` +
  `\`unittest.main()\`. Then run it again; it must exit non-zero before you change any source file.`;

const NOT_A_DEMO_NOT_RUN = (cmd: string, files: string[]): string =>
  `🛡️ \`${cmd}\` did not run the test file you wrote (${files.join(', ')}): the runner only collects tests ` +
  `from its own test modules, and yours is not one of them. Run your file directly -- ` +
  `\`python -m pytest ${files[0]}\` -- or put the test inside the existing test module for the code you are ` +
  `changing. It must fail before you change any source file.`;

const NOT_A_DEMO_IMPORT = (cmd: string): string =>
  `🛡️ \`${cmd}\` failed while IMPORTING your test module (see the traceback above), so no test ran and ` +
  `nothing was demonstrated. Fix the import error in your test file and run it again; it must fail on an ` +
  `assertion, not on an import, before you change any source file.`;

const NOT_A_DEMO_NOTESTS = (cmd: string): string =>
  `🛡️ \`${cmd}\` ran ZERO tests, so it did NOT demonstrate the bug. If you wrote a test, make sure the ` +
  `runner can find it (a \`test_*\` function or a TestCase method, in a file the runner collects) or call ` +
  `it directly from a plain script. Run it again; it must fail before you change any source file.`;

// "Undone", not "reverted": the third smoke saw the model answer a "Reverted
// your edit" message with fifteen git_stage calls in a row. No git vocabulary.
const REPRO_FIRST_REPROMPT = (path: string, n: number, max: number): string =>
  `🛡️ Your edit to \`${path}\` was undone; the file is back to its original content (${n}/${max}).\n\n` +
  `You changed source code before demonstrating the bug. Nothing you run afterwards can tell you ` +
  `whether the change worked, because there is no failing signal to compare against.\n\n` +
  `Do this first, in order:\n` +
  `1. Write a small script (e.g. \`repro.py\`) or a test that exercises the behaviour described in the issue.\n` +
  `2. Run it with run_command. It MUST fail (non-zero exit, assertion error, or traceback) on the current code.\n` +
  `3. Only then make the code change, and re-run the same command to confirm it passes.\n\n` +
  `New files and test files are allowed at any time; edits to existing source are not until step 2 has failed.`;

const RERUN_REPROMPT = (cmd: string): string =>
  `🛡️ Before finishing: you edited source after your reproduction failed, but never re-ran it.\n\n` +
  `Run this again now and confirm it passes:\n  ${cmd}\n\n` +
  `If it still fails, the change is not done. If it passes, also run the scoped tests for the module you ` +
  `changed to check for regressions, then finish.`;

export function reproFirstGuard(opts: ReproFirstOptions): ReproFirstHook {
  const max = opts.maxReverts ?? 3;
  const s: ReproFirstStats = {
    demonstrated: false,
    reproCommand: null,
    reverts: 0,
    gaveUp: false,
    rerunPrompted: false,
    sourceEdits: 0,
    nudges: 0,
  };
  // True once source was edited after the demonstration and the repro has not
  // been re-run since. Cleared when the repro command runs again.
  let staleSinceEdit = false;
  // Basenames of files the model created this run (repro scripts, new tests).
  // A command that runs one of them and exits 0 is a reproduction ATTEMPT that
  // proved nothing; the first smoke showed the model then editing source in the
  // belief it had reproduced the bug, because nothing told it otherwise.
  const written = new Set<string>();
  const writtenPaths: string[] = [];
  const MAX_NUDGES = 3;
  const RUNNER = /runtests\.py|\bpytest\b|python3? -m unittest|manage\.py\s+test\b/;
  const IMPORT_FAIL = /Failed to import test module|ImportError|ModuleNotFoundError/;
  const base = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;

  const say = (t: string): void => opts.onText?.(t);

  return {
    name: 'reproFirstGuard',
    stats: () => ({ ...s }),

    async afterToolResults(state, ctx) {
      const uses = ctx.pendingToolUses ?? [];
      const results = new Map((ctx.toolResults ?? []).map((r) => [r.tool_use_id, r]));
      let mutated = false;
      for (const u of uses) {
        const res = results.get(u.id);
        const text = res?.content ?? '';
        const input = (u.input ?? {}) as { command?: unknown; path?: unknown };

        if (u.name === 'run_command') {
          const cmd = typeof input.command === 'string' ? input.command.trim() : '';
          if (!s.demonstrated) {
            if (isFailingResult(u.name, text, cmd)) {
              s.demonstrated = true;
              s.reproCommand = cmd || u.name;
              say(`🛡️ repro-first: failure demonstrated by \`${s.reproCommand}\``);
            } else if (s.nudges < MAX_NUDGES) {
              // A reproduction attempt that proved nothing. Say WHICH way it
              // proved nothing, a few times at most, or the model reads its
              // own exit-0 script as success (smoke 1), believes a runner
              // label executed a file it never collects (smoke 3), or takes
              // an import error in its own test for a failing test (smoke 3).
              const refersToWritten = [...written].some((b) => cmd.includes(b));
              const testsWritten = writtenPaths.filter(isTestPath);
              const unrun = testsWritten.filter(
                (p) => !cmd.includes(base(p)) && !cmd.includes(base(p).replace(/\.py$/, '')),
              );
              let msg: string | null = null;
              if (written.size > 0 && IMPORT_FAIL.test(text)) msg = NOT_A_DEMO_IMPORT(cmd);
              else if (refersToWritten) msg = ranNothing(text) ? NOT_A_DEMO_NOTESTS(cmd) : NOT_A_DEMO_EXIT0(cmd);
              else if (RUNNER.test(cmd) && unrun.length > 0) msg = NOT_A_DEMO_NOT_RUN(cmd, unrun);
              if (msg) {
                s.nudges++;
                say(msg);
                state.messages.push({ role: 'user', content: msg });
                mutated = true;
              }
            }
          } else if (cmd && cmd === s.reproCommand) {
            staleSinceEdit = false;
          }
          continue;
        }

        if (u.name === 'edit_file' || u.name === 'write_file') {
          const path = typeof input.path === 'string' ? input.path : '';
          const ok = text.startsWith('<tool_output');
          if (!path || !ok) continue;
          if (isTestPath(path) || !opts.isTracked(path)) {
            written.add(base(path)); // reproduction material: always allowed, and remembered
            if (!writtenPaths.includes(path)) writtenPaths.push(path);
            continue;
          }
          if (s.demonstrated) {
            s.sourceEdits++;
            staleSinceEdit = true;
            continue;
          }
          if (s.gaveUp) {
            s.sourceEdits++;
            continue;
          }
          s.reverts++;
          opts.revert(path);
          const msg = REPRO_FIRST_REPROMPT(path, s.reverts, max);
          say(msg);
          state.messages.push({ role: 'user', content: msg });
          mutated = true;
          if (s.reverts >= max) {
            s.gaveUp = true;
            say(`🛡️ repro-first: revert cap reached; no longer enforcing`);
          }
        }
      }
      return { mutated, reason: mutated ? 'repro-first revert' : undefined };
    },

    async onEmptyResponse(state) {
      if (!s.demonstrated || !staleSinceEdit || s.rerunPrompted || !s.reproCommand) return;
      s.rerunPrompted = true;
      const msg = RERUN_REPROMPT(s.reproCommand);
      say(msg);
      state.messages.push({ role: 'user', content: msg });
      return { mutated: true, reason: 'repro-first rerun' };
    },
  };
}
