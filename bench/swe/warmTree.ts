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
  // stderr is kept for the reason; stdout carries nothing (the pattern never
  // matches). The buffer is generous because ENOBUFS kills grep mid-tree: a
  // tree with thousands of unreadable files must not turn into a cold one.
  execFileSync('grep', args, { cwd, env: GREP_ENV, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
};

export interface WarmResult {
  ms: number;
  /**
   * - `full`: grep read the whole tree (exit 0 or 1).
   * - `with-errors`: exit 2. grep read every file it could and named the ones
   *   it couldn't (a permission error, a broken symlink). The tree is warm:
   *   the agent's grep reads the same files and gets the same exit 2, which it
   *   shows as a successful partial search. Reporting this as a failure, as the
   *   warm-up used to, hid that the tree was warm.
   * - `failed`: grep did not run to the end (it could not start, or was killed).
   *   The agent's first search may pay the cold-read cost (16 s on a django
   *   checkout, past the grep tool's 15 s timeout).
   */
  outcome: 'full' | 'with-errors' | 'failed';
  /** Why, when not `full`: grep's first stderr line and a count, or the error code. */
  reason?: string;
}

interface ExecError {
  status?: number | null;
  signal?: string | null;
  code?: string;
  message?: string;
  stderr?: Buffer | string;
}

function stderrSummary(stderr: Buffer | string | undefined): string {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  return lines.length > 1 ? `${lines[0]} (+${lines.length - 1} more)` : lines[0];
}

/** One grep pass over the tree, classified. */
function attempt(dir: string, run: GrepRunner): Omit<WarmResult, 'ms'> {
  try {
    run(grepArgs(WARM_PATTERN, '.'), dir);
    return { outcome: 'full' };
  } catch (err) {
    const e = err as ExecError;
    if (e.status === 1) return { outcome: 'full' };
    const detail = stderrSummary(e.stderr);
    if (typeof e.status === 'number') {
      return {
        outcome: e.status === 2 ? 'with-errors' : 'failed',
        reason: `exit ${e.status}${detail ? `: ${detail}` : ''}`,
      };
    }
    const what = [e.code, e.signal ? `signal ${e.signal}` : '', (e.message ?? '').split('\n')[0]].filter(Boolean);
    return { outcome: 'failed', reason: [...new Set(what)].join(': ') + (detail ? ` (${detail})` : '') };
  }
}

/**
 * Warm the tree and say how it went. A run that never got an exit status (a
 * spawn error such as EAGAIN, or a kill) is retried once. Such a failure can be
 * transient, and when it is the agent's own grep succeeds a moment later, with
 * the tree still cold. An exit status is grep's answer and is not retried.
 */
export function warmWorkingTree(dir: string, run: GrepRunner = defaultRunner): WarmResult {
  const t0 = Date.now();
  let r = attempt(dir, run);
  if (r.outcome === 'failed' && !/^exit \d/.test(r.reason ?? '')) {
    const first = r.reason;
    r = attempt(dir, run);
    if (r.outcome !== 'failed')
      r = { ...r, reason: [r.reason, `first attempt failed: ${first}`].filter(Boolean).join('; ') };
  }
  return { ms: Date.now() - t0, ...r };
}

/** The log line for a warm-up result. */
export function warmLogLine(repo: string, w: WarmResult): string {
  if (w.outcome === 'full') {
    return `[swe] warmed ${repo} working tree in ${w.ms}ms${w.reason ? ` (${w.reason})` : ''}`;
  }
  if (w.outcome === 'with-errors') {
    return `[swe] warmed ${repo} working tree in ${w.ms}ms; grep could not read some files (${w.reason}). The agent's grep skips the same files.`;
  }
  return (
    `[swe] working-tree warm-up FAILED for ${repo} after ${w.ms}ms (${w.reason}); ` +
    `the agent's first search may pay the cold-read cost`
  );
}
