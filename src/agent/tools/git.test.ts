import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gitCommit, gitDiffTool, gitStatus, gitStage, gitLog, gitPush, gitPull, gitBranch, gitStash } from './git.js';
import { AuditBuffer, __setDefaultAuditBufferForTests } from '../audit/auditBuffer.js';
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
      createBranch: vi.fn().mockResolvedValue('branch created'),
      switchBranch: vi.fn().mockResolvedValue('switched'),
      listBranches: vi.fn().mockResolvedValue(['main', 'feature/x']),
      stash: vi.fn().mockResolvedValue('stashed'),
    };
  }
  return { GitCLI: vi.fn().mockImplementation(MockGitCLI) };
});

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

import { exec } from 'child_process';
type ExecCb = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function mockExecResolve(stdout: string) {
  vi.mocked(exec).mockImplementationOnce((_cmd, _opts, cb) => {
    (cb as unknown as ExecCb)(null, { stdout, stderr: '' });
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

  it('returns error prefix on failure', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { diff: vi.fn().mockRejectedValue(new Error('not a git repo')) };
    });
    const result = await gitDiffTool({});
    expect(result).toContain('git diff failed');
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

  it('returns error prefix on failure', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { status: vi.fn().mockRejectedValue(new Error('boom')) };
    });
    const result = await gitStatus();
    expect(result).toContain('git status failed');
  });
});

describe('gitStage', () => {
  it('stages files and returns result', async () => {
    const result = await gitStage({ files: ['src/foo.ts'] });
    expect(result).toContain('staged');
  });

  it('returns error prefix on failure', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { stage: vi.fn().mockRejectedValue(new Error('stage fail')) };
    });
    const result = await gitStage({});
    expect(result).toContain('git stage failed');
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

  it('returns error prefix on failure', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { log: vi.fn().mockRejectedValue(new Error('log fail')) };
    });
    const result = await gitLog({});
    expect(result).toContain('git log failed');
  });
});

describe('gitPush', () => {
  it('calls push without args when setUpstream is false', async () => {
    const result = await gitPush({ setUpstream: false });
    expect(result).toContain('pushed ok');
  });

  it('calls getCurrentBranch + push with origin when setUpstream is true', async () => {
    const pushMock = vi.fn().mockResolvedValue('upstream set + pushed');
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { getCurrentBranch: vi.fn().mockResolvedValue('feature/x'), push: pushMock };
    });
    const result = await gitPush({ setUpstream: true });
    expect(pushMock).toHaveBeenCalledWith('origin', 'feature/x');
    expect(result).toContain('upstream set');
  });

  it('returns error prefix on failure', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { push: vi.fn().mockRejectedValue(new Error('push fail')) };
    });
    const result = await gitPush({});
    expect(result).toContain('git push failed');
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

  it('returns error prefix on failure', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { pull: vi.fn().mockRejectedValue(new Error('conflict')) };
    });
    const result = await gitPull({});
    expect(result).toContain('git pull failed');
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

  it('returns error when create has no name', async () => {
    const result = await gitBranch({ action: 'create' });
    expect(result).toContain('branch name required');
  });

  it('switches branch', async () => {
    const result = await gitBranch({ action: 'switch', name: 'main' });
    expect(result).toContain('switched');
  });

  it('returns error when switch has no name', async () => {
    const result = await gitBranch({ action: 'switch' });
    expect(result).toContain('branch name required');
  });

  it('returns error prefix on failure', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { listBranches: vi.fn().mockRejectedValue(new Error('no git')) };
    });
    const result = await gitBranch({});
    expect(result).toContain('git branch failed');
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

  it('returns error prefix on failure', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { stash: vi.fn().mockRejectedValue(new Error('stash fail')) };
    });
    const result = await gitStash({});
    expect(result).toContain('git stash failed');
  });
});
