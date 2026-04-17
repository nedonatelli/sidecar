import * as path from 'path';
import * as fs from 'fs';
import { GitCLI } from '../../github/git.js';

/**
 * Garbage collection for abandoned shadow worktrees (v0.62.1 p.3 —
 * closes the "VS Code crash mid-shadow-run leaves silent repo
 * corruption" audit finding).
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
 *       but the directory was left behind. Fix: `fs.rmSync`.
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
  let resolvedShadowsRoot = path.resolve(shadowsRoot);
  try {
    if (fs.existsSync(resolvedShadowsRoot)) {
      resolvedShadowsRoot = fs.realpathSync(resolvedShadowsRoot);
    }
  } catch {
    // Stat failed — use the resolve-only form.
  }
  const shadowWorktrees = worktrees.filter((w) => {
    const raw = path.resolve(w.path);
    if (raw.startsWith(path.resolve(shadowsRoot))) return true;
    if (raw.startsWith(resolvedShadowsRoot)) return true;
    try {
      const real = fs.realpathSync(w.path);
      return real.startsWith(resolvedShadowsRoot) || real.startsWith(path.resolve(shadowsRoot));
    } catch {
      return false;
    }
  });

  const liveShadowPaths = new Set<string>();
  for (const wt of shadowWorktrees) {
    // Use statSync (not existsSync) because on macOS git sometimes
    // reports `/private/var/...` while the directory resolves under
    // `/var/...` via symlink. statSync follows the symlink; existsSync
    // on the unresolved path can return false for a path that exists.
    let exists = false;
    try {
      fs.statSync(wt.path);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      // Store BOTH the raw and resolved forms so the class-(b) orphan
      // check below matches either spelling of the same directory.
      liveShadowPaths.add(path.resolve(wt.path));
      try {
        liveShadowPaths.add(fs.realpathSync(wt.path));
      } catch {
        // realpath failed (rare) — resolved path alone is enough.
      }
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
  if (!fs.existsSync(shadowsRoot)) return result;

  let onDisk: string[];
  try {
    onDisk = fs.readdirSync(shadowsRoot);
  } catch (err) {
    result.errors.push({ path: shadowsRoot, message: err instanceof Error ? err.message : String(err) });
    return result;
  }

  for (const name of onDisk) {
    const full = path.join(shadowsRoot, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (liveShadowPaths.has(path.resolve(full))) continue;
    try {
      if (liveShadowPaths.has(fs.realpathSync(full))) continue;
    } catch {
      // realpath failure → treat as orphan.
    }

    // This dir isn't in the worktree list. Either we just pruned its
    // metadata above, OR it was always an orphan. Either way, remove it.
    try {
      fs.rmSync(full, { recursive: true, force: true });
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
