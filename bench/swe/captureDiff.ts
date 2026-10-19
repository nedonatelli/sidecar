import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A touched path left out of the capture, and why. */
export interface DroppedPath {
  path: string;
  reason: 'outside-repo' | 'missing-untracked' | 'ignored';
}

export interface CapturedDiff {
  patch: string;
  dropped: DroppedPath[];
  shellChanged?: string[];
  drift?: ShellChangeDrift;
}

export interface ShellChangeSnapshot {
  head: string;
  status: string;
  trackedPaths: string[];
  untrackedPaths: string[];
}

export interface ShellChangeDrift {
  reason:
    | 'snapshot-unavailable'
    | 'dirty-at-start'
    | 'baseline-mismatch'
    | 'head-diverged'
    | 'process-still-running'
    | 'too-many-paths'
    | 'widespread-change';
  pathCount: number;
  trackedPathCount?: number;
  baseTrackedPathCount?: number;
}

// The hard cap also catches broad drift such as django-10914's 256 changed files
// in a repository with roughly 6,000 tracked files.
const MAX_SHELL_CHANGED_PATHS = 100;
const WIDESPREAD_CHANGE_RATIO = 0.5;
const MIN_TRACKED_PATHS_FOR_WIDESPREAD_CHECK = 20;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
}

/** True when `git` exits 0 -- for the commands whose answer IS the exit code. */
function gitSucceeds(args: string[], cwd: string): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function nulPaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function repoRelativePath(root: string, filePath: string): string | null {
  const relative = path.relative(root, path.resolve(root, filePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export function snapshotShellWorkspace(dir: string): ShellChangeSnapshot {
  return {
    head: git(['rev-parse', 'HEAD'], dir).trim(),
    status: git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir),
    trackedPaths: nulPaths(git(['diff', '--name-only', '-z', 'HEAD', '--'], dir)),
    untrackedPaths: nulPaths(git(['ls-files', '--others', '--exclude-standard', '-z'], dir)),
  };
}

function discoverShellChangedPaths(
  dir: string,
  baseCommit: string,
  touchedPaths: Iterable<string>,
  snapshot: ShellChangeSnapshot | null,
  shellProcessesStopped: boolean,
): { paths: string[]; drift?: ShellChangeDrift } {
  if (!shellProcessesStopped) return { paths: [], drift: { reason: 'process-still-running', pathCount: 0 } };
  if (!snapshot) return { paths: [], drift: { reason: 'snapshot-unavailable', pathCount: 0 } };
  if (snapshot.trackedPaths.length > 0) {
    return {
      paths: [],
      drift: { reason: 'dirty-at-start', pathCount: nulPaths(snapshot.status).length },
    };
  }
  if (snapshot.head !== baseCommit) return { paths: [], drift: { reason: 'baseline-mismatch', pathCount: 0 } };

  const head = git(['rev-parse', 'HEAD'], dir).trim();
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseCommit, head], {
      cwd: dir,
      stdio: 'ignore',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { status?: number }).status === 1) {
      return { paths: [], drift: { reason: 'head-diverged', pathCount: 0 } };
    }
    throw error;
  }

  const tracked = nulPaths(git(['diff', '--name-only', '-z', baseCommit, '--'], dir));
  const untracked = nulPaths(git(['ls-files', '--others', '--exclude-standard', '-z'], dir));
  // Exclude setup artifacts already present at the snapshot; later non-ignored
  // files remain part of the patch, including scratch files left by shell work.
  const baselineUntracked = new Set(snapshot.untrackedPaths);
  const normalizedToolPaths = new Set(
    [...touchedPaths]
      .map((filePath) => repoRelativePath(dir, filePath))
      .filter((filePath): filePath is string => filePath !== null),
  );
  const paths = [...new Set([...tracked, ...untracked.filter((filePath) => !baselineUntracked.has(filePath))])].sort();
  const shellChanged = paths.filter((filePath) => !normalizedToolPaths.has(filePath));
  const shellTracked = tracked.filter((filePath) => !normalizedToolPaths.has(filePath));

  if (shellChanged.length > MAX_SHELL_CHANGED_PATHS) {
    return { paths: [], drift: { reason: 'too-many-paths', pathCount: shellChanged.length } };
  }
  if (shellTracked.length === 0) return { paths: shellChanged };

  const baseTrackedPathCount = nulPaths(git(['ls-tree', '-r', '--name-only', '-z', baseCommit], dir)).length;
  if (
    baseTrackedPathCount >= MIN_TRACKED_PATHS_FOR_WIDESPREAD_CHECK &&
    shellTracked.length > baseTrackedPathCount * WIDESPREAD_CHANGE_RATIO
  ) {
    return {
      paths: [],
      drift: {
        reason: 'widespread-change',
        pathCount: shellChanged.length,
        trackedPathCount: shellTracked.length,
        baseTrackedPathCount,
      },
    };
  }

  return { paths: shellChanged };
}

/**
 * The agent's final patch: `git diff` of base_commit against the working tree,
 * scoped to file-tool paths plus shell changes found since a clean snapshot.
 *
 * Keeping the scope to those paths protects against repo-state drift: stray
 * shell git commands, env setup, or conflicting resets on a cached clone once
 * expanded whole-repo diffs into hundreds of unrelated files (django-10914: a
 * clean one-line fix came back as a 475KB / 256-file "patch"). Shell discovery
 * expands the scope only when the starting snapshot proves the checkout was
 * clean and still descends from base_commit.
 *
 * `touchedPaths` records every file-tool mutation CALL, successful or not. A
 * single bad path made `git add` exit 128 with nothing staged, losing every
 * valid edit with it. So each file-tool path is vetted first, and dropped when:
 *   - it resolves outside the clone (`write_file /tmp/x.py`, refused by the tool
 *     but still recorded),
 *   - it is missing on disk and not tracked at base_commit (a scratch test the
 *     agent wrote and later `rm`'d),
 *   - it is untracked and gitignored (matplotlib's generated `_version.py`).
 * A tracked path that is now missing is KEPT: it is a real deletion and must
 * diff as one.
 */
export function captureDiff(
  dir: string,
  baseCommit: string,
  touchedPaths: Iterable<string>,
  snapshot?: ShellChangeSnapshot | null,
  shellProcessesStopped = true,
): CapturedDiff {
  const root = path.resolve(dir);
  const kept = new Set<string>();
  const dropped: DroppedPath[] = [];
  for (const raw of new Set(touchedPaths)) {
    const abs = path.resolve(root, raw);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      dropped.push({ path: raw, reason: 'outside-repo' });
      continue;
    }
    const posix = rel.split(path.sep).join('/');
    if (posix === '.git' || posix.startsWith('.git/')) {
      dropped.push({ path: raw, reason: 'outside-repo' });
      continue;
    }
    const tracked = gitSucceeds(['cat-file', '-e', `${baseCommit}:${posix}`], root);
    if (!tracked && !fs.existsSync(abs)) {
      dropped.push({ path: raw, reason: 'missing-untracked' });
      continue;
    }
    if (!tracked && gitSucceeds(['check-ignore', '-q', '--', posix], root)) {
      dropped.push({ path: raw, reason: 'ignored' });
      continue;
    }
    kept.add(posix);
  }

  const discovered =
    snapshot === undefined || process.env.SIDECAR_SWE_SHELL_CAPTURE !== '1'
      ? { paths: [] }
      : discoverShellChangedPaths(root, baseCommit, touchedPaths, snapshot, shellProcessesStopped);
  for (const filePath of discovered.paths) kept.add(filePath);

  const result = (): CapturedDiff => ({
    patch: '',
    dropped,
    ...(discovered.paths.length > 0 ? { shellChanged: discovered.paths } : {}),
    ...(discovered.drift ? { drift: discovered.drift } : {}),
  });
  if (kept.size === 0) return result();
  const paths = [...kept];
  git(['add', '-A', '--', ...paths], root);
  return {
    ...result(),
    patch: git(['diff', '--cached', baseCommit, '--', ...paths], root),
  };
}
