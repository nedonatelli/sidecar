import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import { gitEnvForCwd } from '../loop/treeSignature.js';
import { COMMIT_LIMITS, commitCallOf, commitReviewRefusal, reviewCommit } from './commitGuard.js';
import { resolveApprovalNeeded } from './permissionsGate.js';

const use = (name: string, input: Record<string, unknown> = {}): ToolUseContentBlock => ({
  type: 'tool_use',
  id: 't',
  name,
  input,
});

describe('commitCallOf', () => {
  it('matches git_commit and shell commits, and whether the command stages files itself', () => {
    expect(commitCallOf(use('git_commit', { message: 'x' }))).toEqual({
      via: 'git_commit',
      addsFiles: false,
      forceAdds: false,
    });
    expect(commitCallOf(use('run_command', { command: 'git commit -m "fix: x"' }))).toEqual({
      via: 'command',
      addsFiles: false,
      forceAdds: false,
    });
    for (const command of ['git add -A && git commit -m "x"', 'git commit -am "x"', 'git -C repo commit --all -m x']) {
      expect(commitCallOf(use('run_command', { command }))?.addsFiles).toBe(true);
    }
    expect(commitCallOf(use('run_command', { command: 'git commit --amend --no-edit' }))?.addsFiles).toBe(false);
  });

  it('notices a force-add in the same command', () => {
    for (const command of [
      'git add -f logs/a.txt && git commit -m x',
      'git add --force . && git commit -m x',
      'git add -Af && git commit -m x',
    ]) {
      expect(commitCallOf(use('run_command', { command }))?.forceAdds).toBe(true);
    }
    for (const command of [
      'git add -A && git commit -m x',
      'git add -- file-f.ts && git commit -m x',
      'git commit -m "add -f"',
    ]) {
      expect(commitCallOf(use('run_command', { command }))?.forceAdds).toBe(false);
    }
  });

  it('is null for anything that is not a commit', () => {
    for (const command of ['git log --oneline', 'git status', 'echo commit', 'git add .']) {
      expect(commitCallOf(use('run_command', { command }))).toBeNull();
    }
    expect(commitCallOf(use('git_push'))).toBeNull();
  });
});

describe('reviewCommit', () => {
  let repo: string;
  const saved = { ...COMMIT_LIMITS };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: gitEnvForCwd(), stdio: 'pipe' });
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  };
  const staged = { via: 'git_commit' as const, addsFiles: false, forceAdds: false };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-guard-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    write('.gitignore', 'logs/\nnode_modules/\n');
    write('src/a.ts', 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    write('logs/audit.jsonl', '{"tool":"get_setting","result":"machine-specific"}\n');
    write('node_modules/pkg/index.js', 'module.exports = 1;\n');
  });

  afterEach(() => {
    Object.assign(COMMIT_LIMITS, saved);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('passes an ordinary change', async () => {
    write('src/a.ts', 'export const a = 2;\n');
    write('src/b.ts', 'export const b = 1;\n');
    git('add', '.');
    expect(await reviewCommit(staged, repo)).toBeNull();
  });

  it('flags staged copies of an ignored file, naming where they came from', async () => {
    write('bench/results/audit.jsonl', '{"tool":"get_setting","result":"machine-specific"}\n');
    git('add', 'bench');
    const review = await reviewCommit(staged, repo);
    expect(review?.concerns.join('\n')).toMatch(/1 of the new files are copies of files git ignores \(from logs\)/);
  });

  it('sees an unstaged copy only when the command stages it', async () => {
    write('bench/audit.jsonl', '{"tool":"get_setting","result":"machine-specific"}\n');
    expect(await reviewCommit(staged, repo)).toBeNull();
    expect((await reviewCommit({ via: 'command', addsFiles: true, forceAdds: false }, repo))?.concerns[0]).toMatch(
      /copies of files/,
    );
  });

  it('flags an ignored file that was force-staged', async () => {
    git('add', '-f', 'logs/audit.jsonl');
    const text = (await reviewCommit(staged, repo))?.concerns.join('\n') ?? '';
    expect(text).toMatch(/1 new file that \.gitignore excludes \(logs\/audit\.jsonl\): staged with git add -f/);
  });

  it('flags a change to a file tracked before .gitignore matched it, with the way out', async () => {
    write('build/out.js', 'v1\n');
    git('add', 'build/out.js');
    git('commit', '-q', '-m', 'track build');
    write('.gitignore', 'logs/\nnode_modules/\nbuild/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore build');
    write('build/out.js', 'v2\n');
    const text = (await reviewCommit({ via: 'command', addsFiles: true, forceAdds: false }, repo))?.concerns.join('\n');
    expect(text).toMatch(/1 changed file that \.gitignore now excludes \(build\/out\.js\)/);
    expect(text).toMatch(/git rm --cached <path>/);
  });

  it('flags a command that force-adds, before anything is staged', async () => {
    const review = await reviewCommit({ via: 'command', addsFiles: true, forceAdds: true }, repo);
    expect(review?.concerns[0]).toMatch(/force-adds files \(git add -f\)/);
  });

  it('does not treat a copy of a dependency as ignored data', async () => {
    write('vendor/index.js', 'module.exports = 1;\n');
    git('add', 'vendor');
    expect(await reviewCommit(staged, repo)).toBeNull();
  });

  it('flags size, file count and path length past the limits', async () => {
    Object.assign(COMMIT_LIMITS, { totalBytes: 40, fileBytes: 30, newFiles: 2, pathChars: 20 });
    write('src/big.txt', 'x'.repeat(50));
    write('src/c.ts', '1');
    write('src/deeply/nested/folder/d.ts', '2');
    git('add', '.');
    const text = (await reviewCommit(staged, repo))?.concerns.join('\n') ?? '';
    expect(text).toMatch(/Size: 0\.0 MB in 3 files; the largest is src\/big\.txt/);
    expect(text).toMatch(/Files: 3 new files in one commit/);
    expect(text).toMatch(/Paths: 1 longer than 20 characters \(longest 29\)/);
  });

  it('is null outside a repository, leaving the commit to fail by itself', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      expect(await reviewCommit(staged, plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('commit review approval', () => {
  it('asks in every mode, over an explicit allow', () => {
    for (const approvalMode of ['autonomous', 'cautious', 'manual', 'review', 'sandboxed'] as const) {
      expect(
        resolveApprovalNeeded({
          tool: { requiresApproval: false },
          toolName: 'git_commit',
          approvalMode,
          explicitPermission: 'allow',
          isIrrecoverable: false,
          isFlaggedCommit: true,
        }),
      ).toBe(true);
    }
  });

  it('tells the agent not to commit or push another way, and who decided', () => {
    const review = { concerns: ['Size: 70.7 MB in 757 files.'] };
    expect(commitReviewRefusal(review, true)).toMatch(/^The user declined this commit\. Size: 70\.7 MB/);
    expect(commitReviewRefusal(review, true)).toMatch(/Do not commit these files another way, and do not push/);
    expect(commitReviewRefusal(review, false)).toMatch(/no one to ask/);
  });
});
