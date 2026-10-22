// ---------------------------------------------------------------------------
// Did a shell command change the working tree? (#247)
//
// `state.fileMutations` counted only edit_file / write_file / delete_file, so a
// model that edits through run_command (`sed -i`, `cat > f`, `git apply`,
// `python - <<EOF`) stayed "before the first edit" for the whole run. #222's
// nudge then fired where a stop was due. The loop now takes this signature
// around every batch that runs a shell command, and counts a change as a
// mutation.
//
// The signature is `git status --porcelain --untracked-files=no` plus the size
// and mtime of each path it lists. Status alone isn't enough: a file already
// modified stays `M` when a later command modifies it again.
//
// Only TRACKED files count. A new untracked file is usually a scratch script
// (`cat <<EOF > reproduce_issue.py`), not a change to the project, and counting
// it undid #222 for the run that nudge was built for: 31b django-12125 wrote
// only a repro script by shell and would have been stopped instead of nudged.
// Replayed over the 450 recorded runs #222 used, counting tracked files changes
// no stop or nudge before the point the run reached. Ignored paths and anything
// outside the repository never appear either. Outside a git repository, or if
// git fails or is slow, the result is null and the caller counts nothing.
// ---------------------------------------------------------------------------
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { workspace } from 'vscode';

const GIT_TIMEOUT_MS = 5_000;

/** The directory the agent's shell runs in: the override, else the workspace. */
export function shellRoot(cwdOverride: string | undefined): string | undefined {
  return cwdOverride ?? workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Signature of the working tree under `root`, or null when it can't be taken. */
export async function workingTreeSignature(root: string | undefined): Promise<string | null> {
  if (!root) return null;
  const status = await gitStatus(root);
  if (status === null) return null;
  const parts: string[] = [status];
  for (const entry of status.split('\0')) {
    // `XY path`; a rename's original path follows as its own NUL-separated
    // entry and has no status prefix, so it is skipped by the length check.
    if (entry.length < 4 || entry[2] !== ' ') continue;
    const rel = entry.slice(3);
    try {
      const st = await fs.stat(path.join(root, rel));
      parts.push(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${rel}:gone`);
    }
  }
  return parts.join('\n');
}

/**
 * The environment for a git command whose repository is named by `cwd`. Git
 * exports GIT_DIR and GIT_INDEX_FILE to hooks; inherited (the test suite runs
 * in the pre-commit hook), they would point the command at the repository
 * being committed instead of `cwd`'s.
 */
export function gitEnvForCwd(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(k)),
  );
}

function gitStatus(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=no'],
      { cwd: root, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: gitEnvForCwd() },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}
