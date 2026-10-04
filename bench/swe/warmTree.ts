import { execFileSync } from 'node:child_process';
import { grepArgs, GREP_ENV } from '../../src/agent/tools/grepArgs.js';

/**
 * Read every file in a freshly checked-out tree once, before the agent runs.
 *
 * On Windows the FIRST read of a just-written file is slow -- consistent with
 * the real-time scanner inspecting each file on first open -- and `prepareRepo`
 * rewrites thousands of files per task (`reset --hard` + `clean -fdx`).
 * Measured on a django clone: the first `grep -r` after a checkout took
 * 16,309 ms, the identical second one 1,235 ms. Excluding `.git` changed
 * nothing (15,933 ms after the next checkout), so it is the working tree, not
 * the pack files.
 *
 * The agent's `grep` tool has a 15 s timeout, so the model's FIRST search of a
 * task timed out at random -- all 18 "Grep failed" results in a 300-run matrix
 * took 15,012-15,040 ms -- and which arm of a paired A/B paid for it depended on
 * disk-cache state, not on the treatment. Warming the tree here, untimed and
 * outside the agent's turn budget, makes the first search cost what every later
 * one does in both arms.
 *
 * The invocation IS the grep tool's own (grepArgs, src/agent/tools/grepArgs.ts),
 * so it touches exactly the files the agent's searches will. The pattern is one
 * that cannot occur, so grep exits 1 after reading everything. Best-effort: a
 * failure to warm must never fail the task.
 */
export const WARM_PATTERN = 'sidecar_warm_tree_9f3c2a7e_never_matches';

export type GrepRunner = (args: string[], cwd: string) => void;

const defaultRunner: GrepRunner = (args, cwd) => {
  execFileSync('grep', args, { cwd, env: GREP_ENV, stdio: 'ignore', maxBuffer: 1024 * 1024 });
};

/** Returns how long the warm-up took in ms, or null when it could not run. */
export function warmWorkingTree(dir: string, run: GrepRunner = defaultRunner): number | null {
  const t0 = Date.now();
  try {
    run(grepArgs(WARM_PATTERN, '.'), dir);
  } catch (err) {
    // Exit 1 is "no match" -- the expected outcome. Anything else (grep missing,
    // permission errors in a subtree) means some files were not warmed, which
    // costs only speed.
    const status = (err as { status?: number }).status;
    if (status !== 1) return null;
  }
  return Date.now() - t0;
}
