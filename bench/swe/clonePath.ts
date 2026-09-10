import * as path from 'path';

/**
 * Where a repo is cloned for the SWE harness: one STABLE directory per repo.
 *
 * It used to be `mkdtempSync('swe-repo-<repo>-')`, which appends six random
 * characters. That path is passed to buildBaseSystemPrompt as `root`, and the
 * base prompt injects a Session block naming the current root -- so two runs
 * of the same task at the same seed got different prompt tokens on turn 0 and
 * diverged before the first tool call. Measured on a matched A/B where the two
 * arms send an identical prompt until the treatment fires: 50 of 51 tasks
 * diverged, 20 of them at the very first tool call. The pinned seed makes
 * sampling reproducible for the SAME input; it cannot help when the input
 * differs by a random suffix.
 *
 * That silently weakened every paired experiment run on this harness: pairs
 * shared a task and a seed but not a prompt. Some of what was recorded as seed
 * variance was path variance.
 *
 * The repo-cache mode (SIDECAR_SWE_REPO_CACHE) already used a stable name; this
 * brings the default path into line. Concurrent runs sharing a directory is the
 * collision mkdtemp guarded against, and the vitest lock already refuses a
 * second live eval.
 */
export function stableCloneDir(tmpRoot: string, repo: string): string {
  return path.join(tmpRoot, `swe-repo-${repo.replace(/[/\\]/g, '_')}`);
}
