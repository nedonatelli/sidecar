// ---------------------------------------------------------------------------
// Paths `git clean` could not remove (#395).
//
// A model that writes cmd's `2>nul` in Git Bash leaves a real file named `nul`
// in the clone. Windows reserves the name, so `git clean -fdx` fails on it
// ("failed to remove nul: Permission denied") on every later task that reuses
// the clone, and three such tasks in a row stopped a 50-task run. Node's
// fs.rmSync can remove it, so repo preparation deletes whatever git names and
// retries instead of failing the task.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';

/** Repo-relative paths from `warning: failed to remove <path>: <reason>` lines. */
export function failedRemovals(gitError: string): string[] {
  return [...gitError.matchAll(/failed to remove (.+?): [^\n]*$/gm)].map((m) => m[1].replace(/\/$/, ''));
}

/**
 * Remove each path `git clean` reported it could not, staying inside `dir`.
 * Returns the paths removed; a path that still resists is left for the retry to report.
 */
export function removeCleanFailures(dir: string, gitError: string): string[] {
  const root = path.resolve(dir);
  const removed: string[] = [];
  for (const rel of failedRemovals(gitError)) {
    const abs = path.resolve(root, rel);
    if (abs === root || !abs.startsWith(root + path.sep)) continue;
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(rel);
    } catch {
      // Still locked (a test process winding down): the next attempt waits and retries.
    }
  }
  return removed;
}
