import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Hide every commit after a task's base from the agent (#507).
//
// The harness clones the full upstream repository once per repo and
// `reset --hard`s it to each task's base commit. Before this, HEAD was at the
// base but `origin/*`, the tags and every later commit were still reachable,
// so `git log --all` or `git show <sha>` showed the agent the upstream fix
// for the task it was solving. Lite-300 (f40406dd): about 50 runs, all from
// nemotron-3.5-lightning, qwen3.8 and qwen3-coder, went looking. One printed
// "the actual 30479 fix commit" and then read that commit's diff.
//
// The clone is shared by every task on the repo, and a later task's base is
// usually a LATER commit. So the history is hidden, not deleted: HEAD is
// detached at the base, every ref is deleted, the reflog and the
// ORIG_HEAD/FETCH_HEAD files go, and gc is switched off in this clone so the
// now-unreachable later commits stay in the object store for the next task's
// `reset --hard <sha>`. The `origin` remote is kept, because a blobless clone
// fetches blobs lazily through it.
//
// What remains: an object addressed by its exact SHA (`git show <sha>`,
// `git fsck --unreachable`). Nothing in the repo names those SHAs any more.
// A leaderboard-grade run also needs network egress blocked, or the agent can
// `git fetch` the refs back.
// ---------------------------------------------------------------------------

export type GitRunner = (args: string[], cwd: string) => string;

const defaultGit: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();

/** Per-clone config that keeps unreachable objects: the next task may need them. */
export const KEEP_UNREACHABLE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['gc.auto', '0'],
  ['gc.pruneExpire', 'never'],
  ['gc.reflogExpireUnreachable', 'never'],
  ['maintenance.auto', 'false'],
];

/** State files under .git that name commits outside the base's history. */
const STATE_FILES = ['ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

/**
 * Leave `dir` with HEAD detached at `baseCommit` and no ref, reflog entry or
 * state file that reaches any other commit. Call after the hard reset and
 * before the agent starts. Throws when any ref survives.
 */
export function hideHistoryPastBase(dir: string, baseCommit: string, git: GitRunner = defaultGit): void {
  for (const [key, value] of KEEP_UNREACHABLE_CONFIG) git(['config', key, value], dir);
  git(['checkout', '--quiet', '--detach', baseCommit], dir);

  const refs = git(['for-each-ref', '--format=%(refname)'], dir)
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);
  for (const ref of refs) git(['update-ref', '-d', ref], dir);

  const gitDir = path.resolve(dir, git(['rev-parse', '--git-dir'], dir).trim());
  // Reflog: `reflog expire` would honor gc.reflogExpireUnreachable=never, set
  // just above, so the logs directory is removed instead.
  fs.rmSync(path.join(gitDir, 'logs'), { recursive: true, force: true });
  for (const f of STATE_FILES) fs.rmSync(path.join(gitDir, f), { force: true });

  const left = git(['for-each-ref', '--format=%(refname)'], dir).trim();
  if (left)
    throw new Error(`refs survived hiding history past ${baseCommit} in ${dir}: ${left.split('\n').join(', ')}`);
  const head = git(['rev-parse', 'HEAD'], dir).trim();
  if (head !== baseCommit) throw new Error(`HEAD ${head} != base ${baseCommit} after hiding history in ${dir}`);
}
