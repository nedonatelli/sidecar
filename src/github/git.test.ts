import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitCLI } from './git.js';
import { execFile } from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

describe('GitCLI', () => {
  let git: GitCLI;

  beforeEach(() => {
    vi.clearAllMocks();
    git = new GitCLI('/mock/workspace');
  });

  type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
  const cb = (fn: unknown) => fn as ExecCb;
  const ret = () => ({}) as ReturnType<typeof execFile>;

  function mockGitOutput(stdout: string) {
    mockExecFile.mockImplementation((_cmd, _args, _opts, fn: unknown) => {
      cb(fn)(null, stdout, '');
      return ret();
    });
  }

  function mockGitError(message: string, code?: string) {
    mockExecFile.mockImplementation((_cmd, _args, _opts, fn: unknown) => {
      const err = new Error(message) as NodeJS.ErrnoException;
      if (code) err.code = code;
      cb(fn)(err, '', message);
      return ret();
    });
  }

  it('status returns short status', async () => {
    mockGitOutput(' M src/app.ts\n?? new.ts');
    const result = await git.status();
    expect(result).toContain('src/app.ts');
  });

  it('status returns clean message for empty output', async () => {
    mockGitOutput('');
    const result = await git.status();
    expect(result).toBe('Working tree clean.');
  });

  it('log parses commit entries', async () => {
    mockGitOutput('abc1234\tJohn\t2 days ago\tfix: bug');
    const entries = await git.log(5);
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe('abc1234');
    expect(entries[0].author).toBe('John');
    expect(entries[0].message).toBe('fix: bug');
  });

  it('log returns empty for no output', async () => {
    mockGitOutput('');
    const entries = await git.log();
    expect(entries).toEqual([]);
  });

  it('log caps at 50 entries', async () => {
    mockGitOutput('');
    await git.log(100);
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--max-count=50');
  });

  it('diff returns summary and diff', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, '1 file changed', '');
        return ret();
      })
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, '+line\n-line', '');
        return ret();
      });
    const result = await git.diff();
    expect(result.summary).toContain('1 file changed');
    expect(result.diff).toContain('+line');
  });

  it('diff truncates long diffs', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, 'summary', '');
        return ret();
      })
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, 'x'.repeat(20000), '');
        return ret();
      });
    const result = await git.diff();
    expect(result.diff).toContain('[truncated]');
    expect(result.diff.length).toBeLessThan(15000);
  });

  it('stage with specific files calls add with files', async () => {
    mockGitOutput('staged output');
    await git.stage(['file1.ts', 'file2.ts']);
    const firstCall = mockExecFile.mock.calls[0][1] as string[];
    expect(firstCall).toContain('file1.ts');
  });

  it('stage with no files calls add -A', async () => {
    mockGitOutput('');
    await git.stage();
    const firstCall = mockExecFile.mock.calls[0][1] as string[];
    expect(firstCall).toContain('-A');
  });

  it('commit returns nothing-to-commit when no staged changes', async () => {
    mockGitOutput('');
    const result = await git.commit('test commit');
    expect(result).toContain('Nothing to commit');
  });

  it('commit succeeds with staged changes', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, '1 file', '');
        return ret();
      })
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, '', '');
        return ret();
      })
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, 'abc1234 test commit', '');
        return ret();
      });
    const result = await git.commit('test commit');
    expect(result).toContain('Committed');
  });

  it('push calls git push', async () => {
    mockGitOutput('');
    const result = await git.push();
    expect(result).toContain('Push completed');
  });

  it('pull calls git pull', async () => {
    mockGitOutput('');
    const result = await git.pull();
    expect(result).toContain('Pull completed');
  });

  it('createBranch calls checkout -b', async () => {
    mockGitOutput('');
    const result = await git.createBranch('feature');
    expect(result).toContain('feature');
  });

  it('switchBranch calls checkout', async () => {
    mockGitOutput('');
    const result = await git.switchBranch('main');
    expect(result).toContain('main');
  });

  it('getCurrentBranch returns branch name', async () => {
    mockGitOutput('main');
    const branch = await git.getCurrentBranch();
    expect(branch).toBe('main');
  });

  it('listBranches returns branches', async () => {
    mockGitOutput('main\nfeature');
    const branches = await git.listBranches();
    expect(branches).toEqual(['main', 'feature']);
  });

  it('listBranches with all flag', async () => {
    mockGitOutput('main\nremotes/origin/main');
    await git.listBranches(true);
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('-a');
  });

  it('getRemoteUrl returns url', async () => {
    mockGitOutput('https://github.com/user/repo.git');
    const url = await git.getRemoteUrl();
    expect(url).toBe('https://github.com/user/repo.git');
  });

  it('getRemoteUrl returns null on error', async () => {
    mockGitError('no remote');
    const url = await git.getRemoteUrl();
    expect(url).toBeNull();
  });

  it('clone calls git clone', async () => {
    mockGitOutput('');
    const result = await git.clone('https://github.com/user/repo.git', '/tmp/repo');
    expect(result).toContain('Cloned');
  });

  it('stash push with message', async () => {
    mockGitOutput('Saved');
    const result = await git.stash('push', { message: 'wip' });
    expect(result).toBe('Saved');
  });

  it('stash pop', async () => {
    mockGitOutput('');
    const result = await git.stash('pop');
    expect(result).toBe('Stash popped.');
  });

  it('stash apply with index', async () => {
    mockGitOutput('');
    const result = await git.stash('apply', { index: 2 });
    expect(result).toBe('Stash applied.');
  });

  it('stash list', async () => {
    mockGitOutput('stash@{0}: WIP');
    const result = await git.stash('list');
    expect(result).toContain('stash@{0}');
  });

  it('stash drop', async () => {
    mockGitOutput('');
    const result = await git.stash('drop');
    expect(result).toBe('Stash dropped.');
  });

  it('stash unknown action', async () => {
    const result = await git.stash('invalid');
    expect(result).toContain('Unknown stash action');
  });

  it('throws descriptive error when git not found', async () => {
    mockGitError('not found', 'ENOENT');
    await expect(git.status()).rejects.toThrow('Git is not installed');
  });

  it('throws stderr on git command failure', async () => {
    mockGitError('fatal: not a git repository');
    await expect(git.status()).rejects.toThrow('not a git repository');
  });

  // ---------------------------------------------------------------------------
  // pushWithUpstream
  // ---------------------------------------------------------------------------

  it('pushWithUpstream uses -u flag and defaults to origin HEAD', async () => {
    mockGitOutput('');
    const result = await git.pushWithUpstream();
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toEqual(['push', '-u', 'origin', 'HEAD']);
    expect(result).toContain('HEAD');
    expect(result).toContain('origin');
  });

  it('pushWithUpstream accepts custom remote and branch', async () => {
    mockGitOutput('');
    await git.pushWithUpstream('upstream', 'feature/x');
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toEqual(['push', '-u', 'upstream', 'feature/x']);
  });

  it('pushWithUpstream returns git stdout when non-empty', async () => {
    mockGitOutput('Branch feature set up to track remote branch feature from origin.');
    const result = await git.pushWithUpstream();
    expect(result).toContain('set up to track');
  });

  // ---------------------------------------------------------------------------
  // worktreeAdd
  // ---------------------------------------------------------------------------

  it('worktreeAdd passes --detach, path, and ref', async () => {
    mockGitOutput('');
    const result = await git.worktreeAdd('/tmp/shadow-42');
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toEqual(['worktree', 'add', '--detach', '/tmp/shadow-42', 'HEAD']);
    expect(result).toContain('/tmp/shadow-42');
  });

  it('worktreeAdd respects a custom ref', async () => {
    mockGitOutput('');
    await git.worktreeAdd('/tmp/shadow-43', 'abc1234');
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('abc1234');
  });

  // ---------------------------------------------------------------------------
  // worktreeRemove
  // ---------------------------------------------------------------------------

  it('worktreeRemove without force omits --force flag', async () => {
    mockGitOutput('');
    const result = await git.worktreeRemove('/tmp/shadow-42');
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).not.toContain('--force');
    expect(args).toContain('/tmp/shadow-42');
    expect(result).toContain('/tmp/shadow-42');
  });

  it('worktreeRemove with force=true includes --force flag', async () => {
    mockGitOutput('');
    await git.worktreeRemove('/tmp/shadow-42', true);
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--force');
  });

  // ---------------------------------------------------------------------------
  // worktreeList
  // ---------------------------------------------------------------------------

  it('worktreeList returns empty array for empty output', async () => {
    mockGitOutput('');
    const result = await git.worktreeList();
    expect(result).toEqual([]);
  });

  it('worktreeList parses a single non-detached worktree', async () => {
    mockGitOutput(['worktree /workspace', 'HEAD abc123def456', 'branch refs/heads/main', ''].join('\n'));
    const result = await git.worktreeList();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/workspace');
    expect(result[0].head).toBe('abc123def456');
    expect(result[0].branch).toBe('refs/heads/main');
  });

  it('worktreeList marks detached worktrees with null branch', async () => {
    mockGitOutput(['worktree /tmp/shadow-1', 'HEAD deadbeef12345678', 'detached', ''].join('\n'));
    const result = await git.worktreeList();
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBeNull();
    expect(result[0].head).toBe('deadbeef12345678');
  });

  it('worktreeList parses multiple worktrees in sequence', async () => {
    mockGitOutput(
      [
        'worktree /workspace',
        'HEAD aaaa',
        'branch refs/heads/main',
        '',
        'worktree /tmp/shadow-1',
        'HEAD bbbb',
        'detached',
        '',
      ].join('\n'),
    );
    const result = await git.worktreeList();
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('/workspace');
    expect(result[1].path).toBe('/tmp/shadow-1');
    expect(result[1].branch).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // getHeadSha
  // ---------------------------------------------------------------------------

  it('getHeadSha returns full SHA by default', async () => {
    mockGitOutput('abc123def456abc123def456abc123def456abc123');
    const sha = await git.getHeadSha();
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toEqual(['rev-parse', 'HEAD']);
    expect(sha).toBe('abc123def456abc123def456abc123def456abc123');
  });

  it('getHeadSha includes --short when short=true', async () => {
    mockGitOutput('abc1234');
    const sha = await git.getHeadSha(true);
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--short');
    expect(sha).toBe('abc1234');
  });

  // ---------------------------------------------------------------------------
  // diffAgainstHead
  // ---------------------------------------------------------------------------

  it('diffAgainstHead returns tracked diff when no untracked files', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, 'tracked diff content', '');
        return ret();
      })
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, '', ''); // ls-files returns nothing
        return ret();
      });
    const result = await git.diffAgainstHead();
    expect(result).toBe('tracked diff content');
  });

  it('diffAgainstHead concatenates tracked diff with untracked file diffs', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, 'tracked diff', '');
        return ret();
      })
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, 'new-file.ts', ''); // ls-files: one untracked file
        return ret();
      })
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        // git diff --no-index /dev/null new-file.ts — exits 1 but stdout has diff
        const err = new Error('exit 1') as NodeJS.ErrnoException;
        cb(fn)(err, '+new file content', '');
        return ret();
      });
    const result = await git.diffAgainstHead();
    expect(result).toContain('tracked diff');
    expect(result).toContain('+new file content');
  });

  it('diffAgainstHead skips untracked file when diff stdout is empty', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, 'tracked', '');
        return ret();
      })
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        cb(fn)(null, 'ghost.ts', '');
        return ret();
      })
      .mockImplementationOnce((_cmd, _args, _opts, fn: unknown) => {
        const err = new Error('exit 1') as NodeJS.ErrnoException;
        cb(fn)(err, '', ''); // empty stdout — file gone between ls-files and diff
        return ret();
      });
    const result = await git.diffAgainstHead();
    // Only tracked diff, the empty untracked entry is filtered out
    expect(result).toBe('tracked');
  });

  // ---------------------------------------------------------------------------
  // applyPatch
  // ---------------------------------------------------------------------------

  it('applyPatch writes the patch to stdin and returns success message', async () => {
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    mockExecFile.mockImplementation((_cmd, _args, _opts, fn: unknown) => {
      cb(fn)(null, '', '');
      return { stdin: stdinMock } as unknown as ReturnType<typeof execFile>;
    });
    const result = await git.applyPatch('--- a/foo\n+++ b/foo\n+line');
    expect(stdinMock.write).toHaveBeenCalledWith('--- a/foo\n+++ b/foo\n+line');
    expect(stdinMock.end).toHaveBeenCalled();
    expect(result).toBe('Patch applied');
  });

  it('applyPatch passes --check flag when check=true', async () => {
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    mockExecFile.mockImplementation((_cmd, args, _opts, fn: unknown) => {
      cb(fn)(null, '', '');
      return { stdin: stdinMock } as unknown as ReturnType<typeof execFile>;
    });
    await git.applyPatch('diff', { check: true });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--check');
  });

  it('applyPatch passes --index flag when stage=true', async () => {
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    mockExecFile.mockImplementation((_cmd, _args, _opts, fn: unknown) => {
      cb(fn)(null, '', '');
      return { stdin: stdinMock } as unknown as ReturnType<typeof execFile>;
    });
    await git.applyPatch('diff', { stage: true });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--index');
  });

  it('applyPatch throws when git apply fails', async () => {
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    mockExecFile.mockImplementation((_cmd, _args, _opts, fn: unknown) => {
      const err = new Error('conflict');
      cb(fn)(err, '', 'patch does not apply');
      return { stdin: stdinMock } as unknown as ReturnType<typeof execFile>;
    });
    await expect(git.applyPatch('bad diff')).rejects.toThrow('patch does not apply');
  });
});
