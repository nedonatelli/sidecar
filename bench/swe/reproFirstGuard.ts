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
import { classifyTestResult } from '../../src/agent/completionGate.js';

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
export function isFailingResult(toolName: string, result: string): boolean {
  if (/\(exit code: -?[1-9]\d*\)\s*$/.test(result.trim())) return true;
  if (/⚠️ Command timed out/.test(result)) return false; // hung, not failed
  if (toolName === 'run_tests') return classifyTestResult(result) === 'fail';
  return false;
}

const REPRO_FIRST_REPROMPT = (path: string, n: number, max: number): string =>
  `🛡️ Reverted your edit to \`${path}\` (${n}/${max}).\n\n` +
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
  };
  // True once source was edited after the demonstration and the repro has not
  // been re-run since. Cleared when the repro command runs again.
  let staleSinceEdit = false;

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

        if (u.name === 'run_command' || u.name === 'run_tests') {
          const cmd = typeof input.command === 'string' ? input.command.trim() : '';
          if (!s.demonstrated) {
            if (isFailingResult(u.name, text)) {
              s.demonstrated = true;
              s.reproCommand = cmd || u.name;
              say(`🛡️ repro-first: failure demonstrated by \`${s.reproCommand}\``);
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
          if (isTestPath(path) || !opts.isTracked(path)) continue; // reproduction material: always allowed
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
