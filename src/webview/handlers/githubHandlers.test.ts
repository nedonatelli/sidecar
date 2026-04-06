import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGitHubCommand } from './githubHandlers.js';

// Mock dependencies
vi.mock('../../github/git.js', () => ({
  GitCLI: vi.fn().mockImplementation(function () {
    return {
      clone: vi.fn().mockResolvedValue('Cloned successfully'),
      push: vi.fn().mockResolvedValue('Pushed'),
      pull: vi.fn().mockResolvedValue('Pulled'),
      log: vi.fn().mockResolvedValue('commit abc123'),
      diff: vi.fn().mockResolvedValue('diff output'),
      getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
    };
  }),
}));

vi.mock('../../github/api.js', () => {
  const parseRepo = vi.fn((input: string) => {
    const match = input.match(/(?:github\.com\/)?([^/]+)\/([^/.]+)/);
    return match ? { owner: match[1], repo: match[2] } : null;
  });
  const ctor = vi.fn().mockImplementation(function () {
    return {
      listPRs: vi.fn().mockResolvedValue([{ number: 1, title: 'PR 1' }]),
      getPR: vi.fn().mockResolvedValue({ number: 1, title: 'PR 1' }),
      createPR: vi.fn().mockResolvedValue({ number: 2 }),
      listIssues: vi.fn().mockResolvedValue([{ number: 1, title: 'Issue 1' }]),
      getIssue: vi.fn().mockResolvedValue({ number: 1 }),
      createIssue: vi.fn().mockResolvedValue({ number: 2 }),
      listRepoContents: vi.fn().mockResolvedValue([{ name: 'README.md' }]),
    };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctor as any).parseRepo = parseRepo;
  return { GitHubAPI: ctor };
});

vi.mock('../../github/auth.js', () => ({
  getGitHubToken: vi.fn().mockResolvedValue('mock-token'),
}));

function createMockState() {
  return { postMessage: vi.fn() };
}

describe('handleGitHubCommand', () => {
  let state: ReturnType<typeof createMockState>;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createMockState();
  });

  it('posts error when clone url is missing', async () => {
    await handleGitHubCommand(state as never, { command: 'github', action: 'clone' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('repository URL') }),
    );
  });

  it('handles push action', async () => {
    await handleGitHubCommand(state as never, { command: 'github', action: 'push' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'push' }),
    );
  });

  it('handles pull action', async () => {
    await handleGitHubCommand(state as never, { command: 'github', action: 'pull' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'pull' }),
    );
  });

  it('handles log action with default count', async () => {
    await handleGitHubCommand(state as never, { command: 'github', action: 'log' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'log' }),
    );
  });

  it('handles diff action', async () => {
    await handleGitHubCommand(state as never, { command: 'github', action: 'diff', ref1: 'HEAD~1' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'diff' }),
    );
  });

  it('lists PRs using explicit repo', async () => {
    await handleGitHubCommand(state as never, { command: 'github', action: 'listPRs', repo: 'owner/repo' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'listPRs' }),
    );
  });

  it('lists PRs using git remote fallback', async () => {
    await handleGitHubCommand(state as never, { command: 'github', action: 'listPRs' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'listPRs' }),
    );
  });

  it('posts error for invalid repo format', async () => {
    const { GitHubAPI } = await import('../../github/api.js');
    vi.mocked(GitHubAPI.parseRepo).mockReturnValueOnce(null);

    await handleGitHubCommand(state as never, { command: 'github', action: 'listPRs', repo: 'invalid' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Invalid repo') }),
    );
  });

  it('posts error when createPR missing required params', async () => {
    await handleGitHubCommand(
      state as never,
      {
        command: 'github',
        action: 'createPR',
        repo: 'owner/repo',
        title: 'My PR',
        // missing head and base
      } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Usage') }),
    );
  });

  it('posts error when createIssue missing title', async () => {
    await handleGitHubCommand(
      state as never,
      {
        command: 'github',
        action: 'createIssue',
        repo: 'owner/repo',
      } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Usage') }),
    );
  });

  it('catches and reports errors', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(
      () =>
        ({
          push: vi.fn().mockRejectedValue(new Error('auth failed')),
        }) as never,
    );

    await handleGitHubCommand(state as never, { command: 'github', action: 'push' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('auth failed') }),
    );
  });
});
