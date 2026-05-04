import * as path from 'path';
import * as fs from 'fs';
import { GitCLI } from '../../github/git.js';

/**
 * Garbage collection for abandoned shadow worktrees.
 *
 * Two orphan classes exist:
 *
 *   (a) **Registered-but-missing worktrees** — git metadata under
 *       `.git/worktrees/<id>/` points at a shadow path that no longer
 *       exists on disk. Downstream `git status` / `git fetch` /
 *       `git push` may fail mysteriously. Fix: `git worktree remove --force`.
 *
 *   (b) **Directory-without-worktree** — a shadow dir exists on
 *       disk at `.sidecar/shadows/<id>/` but git doesn't know about
 *       it. Probably the `.git/worktrees/` entry was already pruned
 *       but the directory was left behind. Fix: `fs.promises.rm`.
 *
 * Both classes land in this module rather than on the `ShadowWorkspace`
 * class itself because sweeping is a session-level concern, not a
 * per-workspace one — an activation sweep covers every prior session's
 * abandoned state at once.
 *
 * No TTL / age-based pruning yet — any shadow the filesystem + git
 * agree is orphaned gets swept. A user who set `autoCleanup: false`
 * and wants to retain old shadows for post-mortem can disable the
 * sweep via `sidecar.shadowWorkspace.sweepStaleOnActivation: false`
 * (config added in p.3).
 */

export interface SweepResult {
  /** Worktree metadata entries pruned — path under `.sidecar/shadows/`. */
  prunedWorktrees: string[];
  /** Orphan directories deleted — not registered with git. */
  removedDirs: string[];
  /** Problems encountered during sweep; one entry per failed path. */
  errors: Array<{ path: string; message: string }>;
}

/** Resolve a path to its realpath, or return the input if realpath fails. */
async function tryRealpath(p: string): Promise<string> {
  return fs.promises.realpath(p).catch(() => p);
}

/** Return true if the path exists (follows symlinks). */
async function pathExists(p: string): Promise<boolean> {
  return fs.promises.access(p).then(
    () => true,
    () => false,
  );
}

/**
 * Sweep stale shadow worktrees + directories under `mainRoot`.
 * Idempotent and safe to call repeatedly. Non-shadow worktrees
 * (intentional user-created worktrees outside `.sidecar/shadows/`)
 * are never touched.
 */
export async function sweepStaleShadows(mainRoot: string): Promise<SweepResult> {
  const result: SweepResult = { prunedWorktrees: [], removedDirs: [], errors: [] };
  const shadowsRoot = path.join(mainRoot, '.sidecar', 'shadows');
  const git = new GitCLI(mainRoot);

  // --- Class (a): worktree-metadata-without-directory. ---
  let worktrees: Awaited<ReturnType<GitCLI['worktreeList']>> = [];
  try {
    worktrees = await git.worktreeList();
  } catch (err) {
    // Not a git repo or git invocation failed — nothing to sweep.
    // Still attempt the directory-level sweep below in case a user
    // left shadow dirs in a now-non-repo directory.
    result.errors.push({ path: mainRoot, message: err instanceof Error ? err.message : String(err) });
  }

  // Normalize worktree paths for comparison — git sometimes reports
  // `/private/tmp/...` on macOS where the workspace root is `/tmp/...`
  // (symlink chain). `path.resolve` alone doesn't reconcile these;
  // we use realpath on BOTH sides where possible so the prefix check
  // survives the macOS `/private` rewrite.
  const resolvedShadowsRoot = await (async () => {
    const resolved = path.resolve(shadowsRoot);
    if (await pathExists(resolved)) return tryRealpath(resolved);
    return resolved;
  })();

  const shadowWorktrees = await Promise.all(
    worktrees.map(async (w) => {
      const raw = path.resolve(w.path);
      if (raw.startsWith(path.resolve(shadowsRoot))) return w;
      if (raw.startsWith(resolvedShadowsRoot)) return w;
      const real = await tryRealpath(w.path);
      if (real.startsWith(resolvedShadowsRoot) || real.startsWith(path.resolve(shadowsRoot))) return w;
      return null;
    }),
  ).then((results) => results.filter((w): w is NonNullable<typeof w> => w !== null));

  const liveShadowPaths = new Set<string>();
  for (const wt of shadowWorktrees) {
    // Use stat (not access) because on macOS git sometimes reports
    // `/private/var/...` while the directory resolves under `/var/...`
    // via symlink. stat follows the symlink; access on the unresolved
    // path can return false for a path that exists.
    const exists = await fs.promises.stat(wt.path).then(
      () => true,
      () => false,
    );
    if (exists) {
      // Store BOTH the raw and resolved forms so the class-(b) orphan
      // check below matches either spelling of the same directory.
      liveShadowPaths.add(path.resolve(wt.path));
      const real = await tryRealpath(wt.path);
      liveShadowPaths.add(real);
      continue;
    }
    // Directory is gone but git still thinks the worktree exists.
    try {
      await git.worktreeRemove(wt.path, true);
      result.prunedWorktrees.push(wt.path);
    } catch (err) {
      result.errors.push({
        path: wt.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Class (b): directory-without-worktree-metadata. ---
  if (!(await pathExists(shadowsRoot))) return result;

  let onDisk: string[];
  try {
    onDisk = await fs.promises.readdir(shadowsRoot);
  } catch (err) {
    result.errors.push({ path: shadowsRoot, message: err instanceof Error ? err.message : String(err) });
    return result;
  }

  for (const name of onDisk) {
    const full = path.join(shadowsRoot, name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (liveShadowPaths.has(path.resolve(full))) continue;
    const real = await tryRealpath(full);
    if (liveShadowPaths.has(real)) continue;

    // This dir isn't in the worktree list. Either we just pruned its
    // metadata above, OR it was always an orphan. Either way, remove it.
    try {
      await fs.promises.rm(full, { recursive: true, force: true });
      result.removedDirs.push(full);
    } catch (err) {
      result.errors.push({ path: full, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/**
 * Format a `SweepResult` into a one-line summary for logging +
 * user-facing toasts. Empty string when nothing happened — callers
 * should skip the notification in that case to avoid activation-
 * time noise on every launch.
 */
export function formatSweepResult(result: SweepResult): string {
  const total = result.prunedWorktrees.length + result.removedDirs.length;
  if (total === 0 && result.errors.length === 0) return '';
  const parts: string[] = [];
  if (result.prunedWorktrees.length > 0) {
    parts.push(`${result.prunedWorktrees.length} stale worktree${result.prunedWorktrees.length === 1 ? '' : 's'}`);
  }
  if (result.removedDirs.length > 0) {
    parts.push(`${result.removedDirs.length} orphan director${result.removedDirs.length === 1 ? 'y' : 'ies'}`);
  }
  if (result.errors.length > 0) {
    parts.push(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`);
  }
  return `Shadow sweep: ${parts.join(', ')}`;
}
