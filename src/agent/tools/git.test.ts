import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  gitCommit,
  gitDiffTool,
  gitStatus,
  gitStage,
  gitLog,
  gitPush,
  describeGitPush,
  describeShellGitPush,
  pushRemoteInCommand,
  gitPull,
  gitBranch,
  gitStash,
  gitSearchHistory,
} from './git.js';
import { AuditBuffer, __setDefaultAuditBufferForTests } from '../audit/auditBuffer.js';
import { GitCLI } from '../../github/git.js';
import { fetchRepoVisibility } from '../../github/repoVisibility.js';
import * as settings from '../../config/settings.js';

// Mock GitCLI so executor tests don't need a real git repo
vi.mock('../../github/git.js', () => {
  function MockGitCLI() {
    return {
      diff: vi.fn().mockResolvedValue({ summary: '1 file changed', diff: '--- a/foo.ts\n+++ b/foo.ts' }),
      status: vi.fn().mockResolvedValue('On branch main\nnothing to commit'),
      stage: vi.fn().mockResolvedValue('staged: src/foo.ts'),
      commit: vi.fn().mockResolvedValue('committed abc123'),
      log: vi.fn().mockResolvedValue([{ hash: 'abc123', message: 'feat: x', author: 'dev', date: '2024-01-01' }]),
      push: vi.fn().mockResolvedValue('pushed ok'),
      pull: vi.fn().mockResolvedValue('pulled ok'),
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      getRemoteUrl: vi.fn().mockResolvedValue(null),
      createBranch: vi.fn().mockResolvedValue('branch created'),
      switchBranch: vi.fn().mockResolvedValue('switched'),
      listBranches: vi.fn().mockResolvedValue(['main', 'feature/x']),
      stash: vi.fn().mockResolvedValue('stashed'),
    };
  }
  return { GitCLI: vi.fn().mockImplementation(MockGitCLI) };
});

vi.mock('../../github/api.js', () => {
  const GitHubAPI = vi.fn().mockImplementation(function () {
    return {
      getBranchProtection: vi.fn().mockResolvedValue(null),
    };
  });
  (GitHubAPI as unknown as Record<string, unknown>).parseRepo = (url: string) => {
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    return m ? { owner: m[1], repo: m[2] } : null;
  };
  return { GitHubAPI };
});

vi.mock('../../github/repoVisibility.js', () => ({
  fetchRepoVisibility: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../github/auth.js', () => ({
  getGitHubToken: vi.fn().mockResolvedValue('fake-token'),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

import { exec, execFile } from 'child_process';
type ExecCb = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
type ExecFileCb = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function mockExecResolve(stdout: string) {
  vi.mocked(exec).mockImplementationOnce((_cmd, _opts, cb) => {
    (cb as unknown as ExecCb)(null, { stdout, stderr: '' });
    return {} as never;
  });
}

function mockExecFileResolve(stdout: string) {
  vi.mocked(execFile).mockImplementationOnce((_file, _args, _opts, cb) => {
    (cb as unknown as ExecFileCb)(null, { stdout, stderr: '' });
    return {} as never;
  });
}

function mockExecFileReject(err: Error) {
  vi.mocked(execFile).mockImplementationOnce((_file, _args, _opts, cb) => {
    (cb as unknown as ExecFileCb)(err, { stdout: '', stderr: '' });
    return {} as never;
  });
}

/**
 * v0.61 a.4: `git_commit` tool routes through `AuditBuffer.queueCommit`
 * when audit mode is active with `sidecar.audit.bufferGitCommits` on.
 * Scope is tight — we don't test the unrelated pre-existing
 * `GitCLI.commit` path here (that's covered elsewhere by integration
 * and client tests). Just the mode-switch behavior.
 */
describe('gitCommit audit routing', () => {
  let buf: AuditBuffer;
  let getConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    buf = new AuditBuffer();
    __setDefaultAuditBufferForTests(buf);
    getConfigSpy = vi.spyOn(settings, 'getConfig');
  });

  afterEach(() => {
    __setDefaultAuditBufferForTests(null);
    getConfigSpy.mockRestore();
  });

  it('queues the commit in the buffer when agentMode is audit + auditBufferGitCommits is true', async () => {
    getConfigSpy.mockReturnValue({
      agentMode: 'audit',
      auditBufferGitCommits: true,
    } as never);

    const result = await gitCommit({ message: 'feat: buffered' });

    expect(result).toContain('Commit queued in audit buffer');
    expect(result).toContain('feat: buffered');
    expect(buf.hasCommits).toBe(true);
    expect(buf.listCommits()[0].message).toBe('feat: buffered');
  });

  it('does NOT buffer when audit mode is on but auditBufferGitCommits is off', async () => {
    getConfigSpy.mockReturnValue({
      agentMode: 'audit',
      auditBufferGitCommits: false,
    } as never);
    // Don't mock GitCLI.commit — the tool will invoke it and probably
    // fail because tests run outside a git repo, but that's fine. We
    // just assert the buffer was NOT used.
    await gitCommit({ message: 'feat: passthrough' });
    expect(buf.hasCommits).toBe(false);
  });

  it('does NOT buffer when agentMode is not audit', async () => {
    getConfigSpy.mockReturnValue({
      agentMode: 'autonomous',
      auditBufferGitCommits: true,
    } as never);
    await gitCommit({ message: 'feat: passthrough' });
    expect(buf.hasCommits).toBe(false);
  });

  it('preserves the model trailers on the queued commit', async () => {
    getConfigSpy.mockReturnValue({
      agentMode: 'audit',
      auditBufferGitCommits: true,
    } as never);

    const buildModelTrailers = vi.fn(() => 'X-AI-Model: claude-sonnet-4-6 (agent, 3 calls)');
    await gitCommit({ message: 'feat: with trailers' }, { client: { buildModelTrailers } } as never);

    const queued = buf.listCommits()[0];
    expect(queued.extraTrailers).toBe('X-AI-Model: claude-sonnet-4-6 (agent, 3 calls)');
  });
});

// ---------------------------------------------------------------------------
describe('gitDiffTool', () => {
  it('returns summary + compressed diff on success', async () => {
    const result = await gitDiffTool({});
    expect(result).toContain('1 file changed');
  });

  it('THROWS on failure (a returned error string reads as is_error=false)', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { diff: vi.fn().mockRejectedValue(new Error('not a git repo')) };
    });
    await expect(gitDiffTool({})).rejects.toThrow('git diff failed');
  });

  it('passes ref1 and ref2 to GitCLI.diff', async () => {
    const { GitCLI } = await import('../../github/git.js');
    const diffMock = vi.fn().mockResolvedValue({ summary: 'ok', diff: '' });
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { diff: diffMock };
    });
    await gitDiffTool({ ref1: 'HEAD~1', ref2: 'HEAD' });
    expect(diffMock).toHaveBeenCalledWith('HEAD~1', 'HEAD');
  });
});

describe('gitStatus', () => {
  it('returns status string on success', async () => {
    const result = await gitStatus();
    expect(result).toContain('On branch main');
  });

  it('THROWS on failure (a returned error string reads as is_error=false)', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { status: vi.fn().mockRejectedValue(new Error('boom')) };
    });
    await expect(gitStatus()).rejects.toThrow('git status failed');
  });
});

describe('gitStage', () => {
  it('stages files and returns result', async () => {
    const result = await gitStage({ files: ['src/foo.ts'] });
    expect(result).toContain('staged');
  });

  it('THROWS on failure (a returned error string reads as is_error=false)', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { stage: vi.fn().mockRejectedValue(new Error('stage fail')) };
    });
    await expect(gitStage({})).rejects.toThrow('git stage failed');
  });
});

describe('gitLog', () => {
  it('returns formatted commit log', async () => {
    const result = await gitLog({ count: 5 });
    expect(result).toContain('abc123');
    expect(result).toContain('feat: x');
  });

  it('returns "No commits found" when log is empty', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { log: vi.fn().mockResolvedValue([]) };
    });
    const result = await gitLog({});
    expect(result).toBe('No commits found.');
  });

  it('THROWS on failure (a returned error string reads as is_error=false)', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { log: vi.fn().mockRejectedValue(new Error('log fail')) };
    });
    await expect(gitLog({})).rejects.toThrow('git log failed');
  });
});

/** A GitCLI for push tests: on `main`, tracking nothing, remote not on GitHub. */
function pushGit(overrides: Record<string, unknown> = {}) {
  return {
    getCurrentBranch: vi.fn().mockResolvedValue('main'),
    getUpstreamRemote: vi.fn().mockResolvedValue(null),
    getRemoteUrl: vi.fn().mockResolvedValue('https://git.example.com/repo.git'),
    refExists: vi.fn().mockResolvedValue(true),
    unpushedCommits: vi.fn().mockResolvedValue({ count: 0, subjects: [], shortstat: '' }),
    push: vi.fn().mockResolvedValue('pushed ok'),
    pushWithUpstream: vi.fn().mockResolvedValue('pushed with upstream'),
    ...overrides,
  };
}

async function useGit(git: ReturnType<typeof pushGit>) {
  const { GitCLI } = await import('../../github/git.js');
  vi.mocked(GitCLI).mockImplementationOnce(function () {
    return git;
  });
  return git;
}

describe('gitPush', () => {
  it('pushes the current branch to origin when it tracks no remote', async () => {
    const git = await useGit(pushGit());
    const result = await gitPush({ setUpstream: false });
    expect(git.push).toHaveBeenCalledWith('origin', 'main');
    expect(result).toContain('pushed ok');
  });

  it("pushes to the branch's upstream remote, not origin", async () => {
    const git = await useGit(
      pushGit({
        getCurrentBranch: vi.fn().mockResolvedValue('bench/x'),
        getUpstreamRemote: vi.fn().mockResolvedValue('bench'),
      }),
    );
    await gitPush({});
    expect(git.push).toHaveBeenCalledWith('bench', 'bench/x');
  });

  it('pushes to a remote the call names, over the upstream', async () => {
    const git = await useGit(pushGit({ getUpstreamRemote: vi.fn().mockResolvedValue('origin') }));
    await gitPush({ remote: 'mirror' });
    expect(git.getRemoteUrl).toHaveBeenCalledWith('mirror');
    expect(git.push).toHaveBeenCalledWith('mirror', 'main');
  });

  it('sets the upstream when setUpstream is true', async () => {
    const git = await useGit(pushGit({ getCurrentBranch: vi.fn().mockResolvedValue('feature/x') }));
    const result = await gitPush({ setUpstream: true, remote: 'bench' });
    expect(git.pushWithUpstream).toHaveBeenCalledWith('bench', 'feature/x');
    expect(git.push).not.toHaveBeenCalled();
    expect(result).toContain('pushed with upstream');
  });

  it('refuses a remote that is not configured', async () => {
    const git = await useGit(pushGit({ getRemoteUrl: vi.fn().mockResolvedValue(null) }));
    await expect(gitPush({ remote: 'nope' })).rejects.toThrow('No remote named "nope"');
    expect(git.push).not.toHaveBeenCalled();
  });

  it('refuses a detached HEAD', async () => {
    await useGit(pushGit({ getCurrentBranch: vi.fn().mockResolvedValue('') }));
    await expect(gitPush({})).rejects.toThrow('HEAD is detached');
  });

  it('THROWS on failure (a returned error string reads as is_error=false)', async () => {
    await useGit(pushGit({ push: vi.fn().mockRejectedValue(new Error('push fail')) }));
    await expect(gitPush({})).rejects.toThrow('git push failed');
  });
});

describe('describeGitPush', () => {
  it('names the remote URL, a PUBLIC repository, a new branch and the commits', async () => {
    vi.mocked(fetchRepoVisibility).mockResolvedValueOnce('public');
    await useGit(
      pushGit({
        getCurrentBranch: vi.fn().mockResolvedValue('bench/results'),
        getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
        refExists: vi.fn().mockResolvedValue(false),
        unpushedCommits: vi.fn().mockResolvedValue({
          count: 7,
          subjects: ['a1 one', 'b2 two', 'c3 three', 'd4 four', 'e5 five'],
          shortstat: '801 files changed, 512329 insertions(+)',
        }),
      }),
    );
    const text = await describeGitPush({ setUpstream: true });
    expect(text).toContain('Remote: origin → https://github.com/owner/repo.git (PUBLIC repository)');
    expect(text).toContain('Branch: bench/results → origin/bench/results (new branch)');
    expect(text).toContain('Commits: 7 not on origin');
    expect(text).toContain('a1 one');
    expect(text).toContain('… and 2 more');
    expect(text).toContain('801 files changed');
    expect(text).toContain('Sets bench/results to track origin/bench/results.');
    expect(text).toContain('⚠ Anyone can read what this pushes.');
  });

  it('shows a private target without the public warning', async () => {
    vi.mocked(fetchRepoVisibility).mockResolvedValueOnce('private');
    await useGit(
      pushGit({
        getUpstreamRemote: vi.fn().mockResolvedValue('bench'),
        getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/bench.git'),
      }),
    );
    const text = await describeGitPush({});
    expect(text).toContain('Remote: bench → https://github.com/owner/bench.git (private repository)');
    expect(text).not.toContain('(new branch)');
    expect(text).not.toContain('Anyone can read');
  });

  it('says when the target cannot be resolved instead of showing nothing', async () => {
    await useGit(pushGit({ getRemoteUrl: vi.fn().mockResolvedValue(null) }));
    expect(await describeGitPush({ remote: 'gone' })).toContain('Push target could not be resolved');
  });
});

describe('pushRemoteInCommand', () => {
  it.each([
    ['git push origin bench/x', 'origin'],
    ['git push -u bench HEAD', 'bench'],
    ['git push', ''],
    ['git add -A && git commit -m x && git push --set-upstream origin main', 'origin'],
    ['git -C ../repo push mirror main', 'mirror'],
    ['git push https://github.com/o/r.git main', 'https://github.com/o/r.git'],
  ])('%s -> %s', (cmd, remote) => {
    expect(pushRemoteInCommand(cmd)).toBe(remote);
  });

  it('is null for a command that does not push', () => {
    expect(pushRemoteInCommand('git status && git log -1')).toBeNull();
    expect(pushRemoteInCommand('echo git pushing')).toBeNull();
  });
});

describe('describeShellGitPush', () => {
  it('resolves the named remote and flags a public one', async () => {
    vi.mocked(fetchRepoVisibility).mockResolvedValueOnce('public');
    await useGit(
      pushGit({
        getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
        unpushedCommits: vi.fn().mockResolvedValue({ count: 2, subjects: ['a1 one', 'b2 two'], shortstat: '' }),
      }),
    );
    const text = await describeShellGitPush('git push origin bench/x');
    expect(text).toContain('Pushes to: origin → https://github.com/owner/repo.git (PUBLIC repository)');
    expect(text).toContain('Commits on HEAD not on origin (as of the last fetch): 2');
    expect(text).toContain('⚠ Anyone can read what this pushes.');
  });

  it('is null for a command that does not push', async () => {
    expect(await describeShellGitPush('npm test')).toBeNull();
  });
});

describe('gitPush — branch protection', () => {
  it('blocks push when branch requires a PR (pullRequestRequired)', async () => {
    const git = await useGit(
      pushGit({
        getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
        push: vi.fn().mockResolvedValue('should not reach'),
      }),
    );
    const { GitHubAPI } = await import('../../github/api.js');
    vi.mocked(GitHubAPI).mockImplementationOnce(function () {
      return {
        getBranchProtection: vi.fn().mockResolvedValue({
          pullRequestRequired: true,
          requiredApprovingReviews: 2,
          codeOwnersRequired: false,
          requiredStatusChecks: [],
          signedCommitsRequired: false,
          linearHistoryRequired: false,
          enforceAdmins: false,
          forcePushesAllowed: false,
        }),
      };
    });
    vi.spyOn(settings, 'getConfig').mockReturnValue({
      branchProtectionEnabled: true,
      branchProtectionWarnEvenIfPassing: false,
    } as never);
    const result = await gitPush({});
    expect(result).toContain('requires a pull request');
    expect(result).toContain('direct push is blocked');
    expect(result).toContain('Push aborted');
    expect(git.push).not.toHaveBeenCalled();
  });

  it("checks protection on the push's own remote", async () => {
    await useGit(
      pushGit({
        getUpstreamRemote: vi.fn().mockResolvedValue('bench'),
        getRemoteUrl: vi.fn().mockImplementation(async (r: string) => `https://github.com/owner/${r}.git`),
      }),
    );
    const { GitHubAPI } = await import('../../github/api.js');
    const getBranchProtection = vi.fn().mockResolvedValue(null);
    vi.mocked(GitHubAPI).mockImplementationOnce(function () {
      return { getBranchProtection };
    });
    vi.spyOn(settings, 'getConfig').mockReturnValue({ branchProtectionEnabled: true } as never);
    await gitPush({});
    expect(getBranchProtection).toHaveBeenCalledWith('owner', 'bench', 'main');
  });

  it('allows push and appends protection info when warnEvenIfPassing is true', async () => {
    const git = await useGit(
      pushGit({
        getCurrentBranch: vi.fn().mockResolvedValue('feature/x'),
        getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
      }),
    );
    const { GitHubAPI } = await import('../../github/api.js');
    vi.mocked(GitHubAPI).mockImplementationOnce(function () {
      return {
        getBranchProtection: vi.fn().mockResolvedValue({
          pullRequestRequired: false,
          requiredApprovingReviews: undefined,
          codeOwnersRequired: false,
          requiredStatusChecks: ['ci/test'],
          signedCommitsRequired: false,
          linearHistoryRequired: false,
          enforceAdmins: false,
          forcePushesAllowed: false,
        }),
      };
    });
    vi.spyOn(settings, 'getConfig').mockReturnValue({
      branchProtectionEnabled: true,
      branchProtectionWarnEvenIfPassing: true,
    } as never);
    const result = await gitPush({});
    expect(git.push).toHaveBeenCalledWith('origin', 'feature/x');
    expect(result).toContain('pushed ok');
    expect(result).toContain('Branch protection on');
    expect(result).toContain('ci/test');
  });

  it('falls through when branchProtectionEnabled is false', async () => {
    await useGit(pushGit());
    vi.spyOn(settings, 'getConfig').mockReturnValue({ branchProtectionEnabled: false } as never);
    const result = await gitPush({});
    expect(result).toContain('pushed ok');
  });

  it('falls through when getGitHubToken rejects (no token configured)', async () => {
    const { getGitHubToken } = await import('../../github/auth.js');
    vi.mocked(getGitHubToken).mockRejectedValueOnce(new Error('no token'));
    vi.spyOn(settings, 'getConfig').mockReturnValue({
      branchProtectionEnabled: true,
      branchProtectionWarnEvenIfPassing: false,
    } as never);
    await useGit(
      pushGit({
        getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
        push: vi.fn().mockResolvedValue('pushed ok despite no token'),
      }),
    );
    const result = await gitPush({});
    expect(result).toContain('pushed ok despite no token');
  });
});

describe('gitPull', () => {
  it('calls GitCLI.pull for a plain merge pull', async () => {
    const result = await gitPull({ rebase: false });
    expect(result).toContain('pulled ok');
  });

  it('uses execAsync for rebase pull', async () => {
    mockExecResolve('Already up to date.');
    const result = await gitPull({ rebase: true });
    expect(result).toContain('Already up to date.');
  });

  it('THROWS on failure (a returned error string reads as is_error=false)', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { pull: vi.fn().mockRejectedValue(new Error('conflict')) };
    });
    await expect(gitPull({})).rejects.toThrow('git pull failed');
  });
});

describe('gitBranch', () => {
  it('lists branches by default', async () => {
    const result = await gitBranch({});
    expect(result).toContain('main');
    expect(result).toContain('feature/x');
  });

  it('returns "No branches found" when list is empty', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { listBranches: vi.fn().mockResolvedValue([]) };
    });
    const result = await gitBranch({ action: 'list' });
    expect(result).toBe('No branches found.');
  });

  it('creates a branch', async () => {
    const result = await gitBranch({ action: 'create', name: 'feature/y' });
    expect(result).toContain('branch created');
  });

  it('THROWS when create has no name (a returned error reads as is_error=false)', async () => {
    await expect(gitBranch({ action: 'create' })).rejects.toThrow('branch name required');
  });

  it('switches branch', async () => {
    const result = await gitBranch({ action: 'switch', name: 'main' });
    expect(result).toContain('switched');
  });

  it('THROWS when switch has no name (a returned error reads as is_error=false)', async () => {
    await expect(gitBranch({ action: 'switch' })).rejects.toThrow('branch name required');
  });

  it('THROWS on failure (a returned error string reads as is_error=false)', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { listBranches: vi.fn().mockRejectedValue(new Error('no git')) };
    });
    await expect(gitBranch({})).rejects.toThrow('git branch failed');
  });
});

describe('gitStash', () => {
  it('stashes current changes', async () => {
    const result = await gitStash({ action: 'push' });
    expect(result).toContain('stashed');
  });

  it('passes message and index to GitCLI.stash', async () => {
    const stashMock = vi.fn().mockResolvedValue('ok');
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { stash: stashMock };
    });
    await gitStash({ action: 'pop', index: 2, message: 'WIP' });
    expect(stashMock).toHaveBeenCalledWith('pop', { message: 'WIP', index: 2 });
  });

  it('THROWS on failure (a returned error string reads as is_error=false)', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { stash: vi.fn().mockRejectedValue(new Error('stash fail')) };
    });
    await expect(gitStash({})).rejects.toThrow('git stash failed');
  });
});

// ---------------------------------------------------------------------------
// gitSearchHistory — shell injection & argument isolation
// ---------------------------------------------------------------------------
describe('gitSearchHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('THROWS when query is missing (a returned error reads as is_error=false)', async () => {
    await expect(gitSearchHistory({})).rejects.toThrow('Error: query is required.');
  });

  it('passes query as a separate execFile argument (not shell-interpolated)', async () => {
    const maliciousQuery = '; rm -rf / #';
    // Two execFile calls: message search + content search (search_type defaults to 'both')
    mockExecFileResolve('');
    mockExecFileResolve('');

    await gitSearchHistory({ query: maliciousQuery });

    const calls = vi.mocked(execFile).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // The args array (second param) must contain the raw query as a single element —
    // never shell-split. The full arg must be '--grep=; rm -rf / #', not two tokens.
    const argsArray = calls[0][1] as string[];
    const grepArg = argsArray.find((a) => (a as string).startsWith('--grep='));
    expect(grepArg).toBe(`--grep=${maliciousQuery}`);
    // No argument should be just 'rm' or '-rf'
    expect(argsArray).not.toContain('rm');
    expect(argsArray).not.toContain('-rf');
  });

  it('passes backtick query as a literal string (no command substitution)', async () => {
    const query = '`whoami`';
    mockExecFileResolve('');
    mockExecFileResolve('');

    await gitSearchHistory({ query });

    const argsArray = vi.mocked(execFile).mock.calls[0][1] as string[];
    const grepArg = argsArray.find((a) => (a as string).startsWith('--grep='));
    expect(grepArg).toBe(`--grep=${query}`);
  });

  it('passes $() subshell query as a literal string', async () => {
    const query = '$(cat /etc/passwd)';
    mockExecFileResolve('');
    mockExecFileResolve('');

    await gitSearchHistory({ query });

    const argsArray = vi.mocked(execFile).mock.calls[0][1] as string[];
    const grepArg = argsArray.find((a) => (a as string).startsWith('--grep='));
    expect(grepArg).toBe(`--grep=${query}`);
  });

  it('uses execFile (not exec) so no shell is spawned', async () => {
    mockExecFileResolve('');
    mockExecFileResolve('');

    await gitSearchHistory({ query: 'anything' });

    expect(vi.mocked(execFile).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(exec).mock.calls.length).toBe(0);
  });

  it('returns "No commits found" when both searches return empty', async () => {
    mockExecFileResolve('');
    mockExecFileResolve('');

    const result = await gitSearchHistory({ query: 'nonexistent' });
    expect(result).toContain('No commits found');
  });

  it('formats found commits correctly', async () => {
    const fakeLine = 'abc1234567|2024-01-15|Alice|feat: add rate limiting';
    // search_type='message' → only one execFile call
    mockExecFileResolve(fakeLine);

    const result = await gitSearchHistory({ query: 'rate limiting', search_type: 'message' });
    expect(result).toContain('abc123456');
    expect(result).toContain('Alice');
    expect(result).toContain('rate limiting');
    expect(result).toContain('[matched via: message]');
  });

  it('caps max_results at 100', async () => {
    mockExecFileResolve('');
    mockExecFileResolve('');

    await gitSearchHistory({ query: 'test', max_results: 9999 });

    const argsArray = vi.mocked(execFile).mock.calls[0][1] as string[];
    // The count arg is `-${maxResults}` — capped at -100, not -9999
    expect(argsArray).toContain('-100');
    expect(argsArray).not.toContain('-9999');
  });

  it('absorbs execFile failure via .catch and returns no commits', async () => {
    // Both searches use .catch(() => '') so an error produces empty output
    mockExecFileReject(new Error('not a git repo'));

    const result = await gitSearchHistory({ query: 'test', search_type: 'message' });
    expect(result).toContain('No commits found');
  });
});

// Shadow-workspace isolation: git tools must run against context.cwd (the shadow
// worktree) instead of the main tree, so a shadow/fork/facet agent's stage/commit
// never touch the user's real repo. When no cwd is set, GitCLI is constructed with
// undefined — identical to the pre-existing default (workspace root).
describe('git tools honor context.cwd (shadow isolation)', () => {
  const SHADOW = '/tmp/.sidecar/shadows/task-1';

  beforeEach(() => {
    vi.mocked(GitCLI).mockClear();
  });

  it('threads context.cwd into GitCLI for status/diff/stage/log/branch/stash', async () => {
    await gitStatus({}, { cwd: SHADOW });
    await gitDiffTool({}, { cwd: SHADOW });
    await gitStage({ files: ['a.ts'] }, { cwd: SHADOW });
    await gitLog({}, { cwd: SHADOW });
    await gitBranch({ action: 'list' }, { cwd: SHADOW });
    await gitStash({ action: 'list' }, { cwd: SHADOW });

    expect(vi.mocked(GitCLI).mock.calls.length).toBe(6);
    for (const call of vi.mocked(GitCLI).mock.calls) {
      expect(call[0]).toBe(SHADOW);
    }
  });

  // refs/stash and branches are shared by every worktree: a stash or branch
  // change in a shadow acted on the user's own repository (a popped stash left
  // it and was lost with the shadow).
  it.each([
    ['stash push', () => gitStash({ action: 'push' }, { cwd: SHADOW })],
    ['stash pop', () => gitStash({ action: 'pop' }, { cwd: SHADOW })],
    ['branch create', () => gitBranch({ action: 'create', name: 'x' }, { cwd: SHADOW })],
  ])('refuses %s in a shadow, touching no repository', async (_label, run) => {
    await expect(run()).rejects.toThrow(/not available in a sandboxed run/);
    expect(vi.mocked(GitCLI)).not.toHaveBeenCalled();
  });

  it('commits into the shadow worktree, not the main repo', async () => {
    await gitCommit({ message: 'fix: x' }, { cwd: SHADOW });
    expect(vi.mocked(GitCLI)).toHaveBeenCalledWith(SHADOW);
  });

  it('passes undefined to GitCLI when no cwd override is present', async () => {
    await gitStatus({});
    expect(vi.mocked(GitCLI)).toHaveBeenCalledWith(undefined);
  });
});
