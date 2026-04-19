import { execFile } from 'child_process';
import { workspace } from 'vscode';
import type { GitCommitInfo, GitDiffResult } from './types.js';

const MAX_DIFF_LENGTH = 10_000;
const MAX_LOG_ENTRIES = 50;

export class GitCLI {
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd || workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  }

  private exec(args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: cwd || this.cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const message = stderr?.trim() || err.message;
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error('Git is not installed or not in your PATH.'));
          } else {
            reject(new Error(message));
          }
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async clone(repoUrl: string, targetDir: string): Promise<string> {
    await this.exec(['clone', repoUrl, targetDir], targetDir.replace(/[/\\][^/\\]*$/, ''));
    return `Cloned ${repoUrl} into ${targetDir}`;
  }

  async push(remote: string = 'origin', branch?: string): Promise<string> {
    const args = ['push', remote];
    if (branch) args.push(branch);
    const result = await this.exec(args);
    return result || 'Push completed successfully.';
  }

  /**
   * Push with `-u` so the local branch tracks the remote one — used
   * by the Draft PR flow (v0.68 chunk 2) to set upstream tracking
   * on the first push of a feature branch. Defaults to `HEAD` so
   * the caller doesn't have to resolve the current branch name.
   */
  async pushWithUpstream(remote: string = 'origin', branch: string = 'HEAD'): Promise<string> {
    const result = await this.exec(['push', '-u', remote, branch]);
    return result || `Pushed ${branch} to ${remote} with upstream tracking.`;
  }

  async pull(remote: string = 'origin', branch?: string): Promise<string> {
    const args = ['pull', remote];
    if (branch) args.push(branch);
    const result = await this.exec(args);
    return result || 'Pull completed successfully.';
  }

  async log(count: number = 10): Promise<GitCommitInfo[]> {
    const n = Math.min(count, MAX_LOG_ENTRIES);
    const output = await this.exec(['log', `--max-count=${n}`, '--format=%h\t%an\t%ar\t%s']);
    if (!output) return [];

    return output.split('\n').map((line) => {
      const [hash, author, date, ...messageParts] = line.split('\t');
      return { hash, author, date, message: messageParts.join('\t') };
    });
  }

  async diff(ref1?: string, ref2?: string): Promise<GitDiffResult> {
    const args = ['diff', '--stat'];
    if (ref1) args.push(ref1);
    if (ref2) args.push(ref2);
    const summary = await this.exec(args);

    const fullArgs = ['diff'];
    if (ref1) fullArgs.push(ref1);
    if (ref2) fullArgs.push(ref2);
    let diff = await this.exec(fullArgs);

    if (diff.length > MAX_DIFF_LENGTH) {
      diff = diff.slice(0, MAX_DIFF_LENGTH) + '\n\n[truncated]';
    }

    return { summary: summary || 'No changes.', diff: diff || 'No diff output.' };
  }

  async status(): Promise<string> {
    const output = await this.exec(['status', '--short']);
    return output || 'Working tree clean.';
  }

  async stage(files?: string[]): Promise<string> {
    if (files && files.length > 0) {
      await this.exec(['add', ...files]);
    } else {
      await this.exec(['add', '-A']);
    }
    const output = await this.exec(['diff', '--cached', '--stat']);
    return output ? `Staged:\n${output}` : 'No changes to stage.';
  }

  async commit(message: string, extraTrailers?: string): Promise<string> {
    const staged = await this.exec(['diff', '--cached', '--stat']);
    if (!staged) {
      return 'Nothing to commit — no staged changes. Use git_stage first.';
    }

    // Git trailers live at the tail of the commit message, separated from the
    // body by a blank line. We always append the SideCar Co-Authored-By, then
    // add any caller-supplied trailers (e.g. X-AI-Model entries) right after.
    const trailerBlock = [
      'Co-Authored-By: SideCar <274544454+SideCarAI-Bot@users.noreply.github.com>',
      ...(extraTrailers ? [extraTrailers] : []),
    ].join('\n');
    const fullMessage = `${message}\n\n${trailerBlock}`;
    await this.exec(['commit', '-m', fullMessage]);

    const log = await this.exec(['log', '--oneline', '-1']);
    return `Committed: ${log}\nFiles:\n${staged}`;
  }

  async stash(action: string = 'push', options?: { message?: string; index?: number }): Promise<string> {
    switch (action) {
      case 'push': {
        const args = ['stash', 'push'];
        if (options?.message) args.push('-m', options.message);
        return (await this.exec(args)) || 'No local changes to stash.';
      }
      case 'pop': {
        const args = ['stash', 'pop'];
        if (options?.index !== undefined) args.push(`stash@{${options.index}}`);
        return (await this.exec(args)) || 'Stash popped.';
      }
      case 'apply': {
        const args = ['stash', 'apply'];
        if (options?.index !== undefined) args.push(`stash@{${options.index}}`);
        return (await this.exec(args)) || 'Stash applied.';
      }
      case 'list': {
        return (await this.exec(['stash', 'list'])) || 'No stashes.';
      }
      case 'drop': {
        const args = ['stash', 'drop'];
        if (options?.index !== undefined) args.push(`stash@{${options.index}}`);
        return (await this.exec(args)) || 'Stash dropped.';
      }
      default:
        return `Unknown stash action: ${action}. Use push, pop, apply, list, or drop.`;
    }
  }

  async createBranch(name: string): Promise<string> {
    await this.exec(['checkout', '-b', name]);
    return `Created and switched to branch: ${name}`;
  }

  async switchBranch(name: string): Promise<string> {
    await this.exec(['checkout', name]);
    return `Switched to branch: ${name}`;
  }

  async getRemoteUrl(): Promise<string | null> {
    try {
      return await this.exec(['remote', 'get-url', 'origin']);
    } catch {
      return null;
    }
  }

  async getCurrentBranch(): Promise<string> {
    return this.exec(['branch', '--show-current']);
  }

  async listBranches(all: boolean = false): Promise<string[]> {
    const args = all ? ['branch', '-a'] : ['branch', '--format=%(refname:short)'];
    const output = await this.exec(args);
    return output ? output.split('\n') : [];
  }

  // --- Worktree primitives (used by ShadowWorkspace) ---

  /**
   * Create a new git worktree at `targetPath` pointing at `ref` (HEAD by
   * default). The worktree shares the main repository's object database,
   * so the only on-disk cost is the tracked-source checkout — not a full
   * repo clone. Used by ShadowWorkspace to spin up a sandbox for an
   * agent task without touching the main working tree.
   */
  async worktreeAdd(targetPath: string, ref: string = 'HEAD'): Promise<string> {
    // `--detach` avoids creating a new branch for the worktree — shadows
    // are ephemeral and never merged as a branch; we produce a patch and
    // apply it back to main instead.
    await this.exec(['worktree', 'add', '--detach', targetPath, ref]);
    return `Worktree created at ${targetPath} (off ${ref})`;
  }

  /**
   * Remove a git worktree. `force: true` allows removal even if the
   * worktree has uncommitted changes — appropriate for shadow teardown
   * on reject, since the changes are being thrown away deliberately.
   */
  async worktreeRemove(targetPath: string, force: boolean = false): Promise<string> {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(targetPath);
    await this.exec(args);
    return `Worktree removed: ${targetPath}`;
  }

  /**
   * List all worktrees registered with this repository. Parsed from the
   * porcelain format which is stable and script-friendly.
   */
  async worktreeList(): Promise<Array<{ path: string; head: string; branch: string | null }>> {
    const output = await this.exec(['worktree', 'list', '--porcelain']);
    if (!output) return [];
    const worktrees: Array<{ path: string; head: string; branch: string | null }> = [];
    let current: Partial<{ path: string; head: string; branch: string | null }> = {};
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current as { path: string; head: string; branch: string | null });
        current = { path: line.slice('worktree '.length), head: '', branch: null };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length);
      } else if (line === 'detached') {
        current.branch = null;
      }
    }
    if (current.path) worktrees.push(current as { path: string; head: string; branch: string | null });
    return worktrees;
  }

  /** Short-SHA of the current HEAD (useful for tagging shadow workspaces by the ref they branched from). */
  async getHeadSha(short: boolean = false): Promise<string> {
    const args = ['rev-parse'];
    if (short) args.push('--short');
    args.push('HEAD');
    return this.exec(args);
  }

  /**
   * Produce a unified diff of working-tree changes vs HEAD, including
   * untracked files. For ShadowWorkspace this is what lands in the review
   * panel and gets applied to main on accept.
   *
   * The diff is produced from the perspective of the CLI's cwd (set via
   * the GitCLI constructor), so a ShadowWorkspace pointing at the shadow
   * path produces a patch of shadow-vs-HEAD.
   */
  async diffAgainstHead(): Promise<string> {
    // Tracked changes (staged + unstaged), rooted at HEAD.
    const tracked = await this.exec(['diff', 'HEAD']);
    // Untracked files need a second pass — `git diff HEAD` doesn't see
    // them. List them, then synthesize "new file" diffs via
    // `git diff --no-index /dev/null <file>`. That form intentionally
    // exits 1 whenever the two files differ (which they always do here,
    // since one is /dev/null), so we can't route it through the normal
    // exec helper that rejects on non-zero exit — the diff itself IS
    // the stdout we need. Use execFile directly and ignore the 1-exit.
    const untrackedList = await this.exec(['ls-files', '--others', '--exclude-standard']);
    if (!untrackedList) return tracked;
    const untrackedDiffs: string[] = [];
    for (const file of untrackedList.split('\n').filter(Boolean)) {
      const diff = await new Promise<string>((resolve) => {
        execFile(
          'git',
          ['diff', '--no-index', '--', '/dev/null', file],
          { cwd: this.cwd, maxBuffer: 4 * 1024 * 1024 },
          (_err, stdout) => {
            // `git diff --no-index` ALWAYS exits 1 when the files differ
            // (which they always do here, since one is /dev/null). The
            // diff content is on stdout regardless. We accept whatever
            // stdout has — if execFile failed outright (git missing, file
            // gone), stdout is empty and we skip silently.
            resolve((stdout as string) || '');
          },
        );
      });
      if (diff) untrackedDiffs.push(diff);
    }
    return [tracked, ...untrackedDiffs].filter(Boolean).join('\n');
  }

  /**
   * Apply a unified diff patch to the current working tree. Used when
   * accepting a shadow workspace's changes — the diff is produced in
   * the shadow via `diffAgainstHead()` and re-applied here (against
   * main) via `git apply --index` so staged changes reflect what the
   * user accepted.
   *
   * Throws on conflict so the caller can surface them to the user
   * instead of producing a half-applied state.
   */
  async applyPatch(patch: string, options: { check?: boolean; stage?: boolean } = {}): Promise<string> {
    const args = ['apply'];
    if (options.check) args.push('--check');
    if (options.stage) args.push('--index');
    // git apply reads the patch from stdin. We run it via a child process
    // with stdin piped in — go through a small helper since the existing
    // `exec` wrapper is stdout-only.
    return new Promise((resolve, reject) => {
      const proc = execFile('git', args, { cwd: this.cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr as string)?.trim() || err.message));
          return;
        }
        resolve((stdout as string)?.trim() || 'Patch applied');
      });
      proc.stdin?.write(patch);
      proc.stdin?.end();
    });
  }
}
