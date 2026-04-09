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

  async commit(message: string): Promise<string> {
    const staged = await this.exec(['diff', '--cached', '--stat']);
    if (!staged) {
      return 'Nothing to commit — no staged changes. Use git_stage first.';
    }

    const fullMessage = `${message}\n\nCo-Authored-By: SideCar <274544454+SideCarAI-Bot@users.noreply.github.com>`;
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
}
