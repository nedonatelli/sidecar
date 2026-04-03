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
    const output = await this.exec([
      'log', `--max-count=${n}`,
      '--format=%h\t%an\t%ar\t%s',
    ]);
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

  async listBranches(): Promise<string[]> {
    const output = await this.exec(['branch', '--format=%(refname:short)']);
    return output ? output.split('\n') : [];
  }
}
