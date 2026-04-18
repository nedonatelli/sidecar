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
      listReleases: vi.fn().mockResolvedValue([{ tag_name: 'v1.0.0' }]),
      getRelease: vi.fn().mockResolvedValue({ id: 42, tag_name: 'v1.0.0' }),
      getLatestRelease: vi.fn().mockResolvedValue({ id: 99, tag_name: 'latest' }),
      createRelease: vi.fn().mockResolvedValue({ id: 7, tag_name: 'v2.0.0' }),
      deleteRelease: vi.fn().mockResolvedValue(undefined),
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

  it('clone no-ops cleanly when the user dismisses the folder picker', async () => {
    const vsc = (await import('vscode')) as unknown as {
      window: { showOpenDialog: (...args: unknown[]) => Promise<unknown> };
    };
    const dialogSpy = vi.fn().mockResolvedValue(undefined);
    const prior = vsc.window.showOpenDialog;
    vsc.window.showOpenDialog = dialogSpy;
    try {
      await handleGitHubCommand(
        state as never,
        { command: 'github', action: 'clone', url: 'https://github.com/a/b.git' } as never,
      );
      expect(dialogSpy).toHaveBeenCalled();
      expect(state.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: 'githubResult', githubAction: 'clone' }),
      );
    } finally {
      vsc.window.showOpenDialog = prior;
    }
  });

  it('clone runs the GitCLI and posts progress + result when the user picks a folder', async () => {
    const vsc = (await import('vscode')) as unknown as {
      window: {
        showOpenDialog: (...args: unknown[]) => Promise<unknown>;
        showInformationMessage: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const priorDialog = vsc.window.showOpenDialog;
    const priorInfo = vsc.window.showInformationMessage;
    vsc.window.showOpenDialog = vi.fn().mockResolvedValue([{ fsPath: '/tmp/target' }]);
    vsc.window.showInformationMessage = vi.fn().mockResolvedValue(undefined);
    try {
      await handleGitHubCommand(
        state as never,
        { command: 'github', action: 'clone', url: 'https://github.com/a/b.git' } as never,
      );
      expect(state.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'githubResult', githubAction: 'clone', githubData: 'Cloning...' }),
      );
      expect(state.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'githubResult',
          githubAction: 'clone',
          githubData: 'Cloned successfully',
        }),
      );
    } finally {
      vsc.window.showOpenDialog = priorDialog;
      vsc.window.showInformationMessage = priorInfo;
    }
  });

  it('getPR returns a specific PR by number', async () => {
    await handleGitHubCommand(
      state as never,
      { command: 'github', action: 'getPR', repo: 'owner/repo', number: 1 } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'getPR' }),
    );
  });

  it('createPR posts result when title/head/base are all supplied', async () => {
    await handleGitHubCommand(
      state as never,
      {
        command: 'github',
        action: 'createPR',
        repo: 'owner/repo',
        title: 'New PR',
        head: 'feature',
        base: 'main',
      } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'createPR' }),
    );
  });

  it('listIssues posts the issue array', async () => {
    await handleGitHubCommand(state as never, { command: 'github', action: 'listIssues', repo: 'owner/repo' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'listIssues' }),
    );
  });

  it('getIssue posts the issue by number', async () => {
    await handleGitHubCommand(
      state as never,
      { command: 'github', action: 'getIssue', repo: 'owner/repo', number: 1 } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'getIssue' }),
    );
  });

  it('createIssue posts the issue when title is supplied', async () => {
    await handleGitHubCommand(
      state as never,
      { command: 'github', action: 'createIssue', repo: 'owner/repo', title: 'Bug' } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'createIssue' }),
    );
  });

  it('listReleases posts the releases array', async () => {
    await handleGitHubCommand(
      state as never,
      { command: 'github', action: 'listReleases', repo: 'owner/repo' } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'listReleases' }),
    );
  });

  it('getRelease with a tag returns that specific release', async () => {
    await handleGitHubCommand(
      state as never,
      { command: 'github', action: 'getRelease', repo: 'owner/repo', tag: 'v1.0.0' } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'getRelease' }),
    );
  });

  it('getRelease without a tag falls back to getLatestRelease', async () => {
    await handleGitHubCommand(state as never, { command: 'github', action: 'getRelease', repo: 'owner/repo' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'getRelease' }),
    );
  });

  it('createRelease posts error when tag is missing', async () => {
    await handleGitHubCommand(
      state as never,
      { command: 'github', action: 'createRelease', repo: 'owner/repo' } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Usage') }),
    );
  });

  it('createRelease posts result when tag is supplied', async () => {
    await handleGitHubCommand(
      state as never,
      {
        command: 'github',
        action: 'createRelease',
        repo: 'owner/repo',
        tag: 'v2.0.0',
        title: 'Release 2.0.0',
        draft: false,
        prerelease: false,
        generateNotes: true,
      } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'createRelease' }),
    );
  });

  it('deleteRelease posts error when tag is missing', async () => {
    await handleGitHubCommand(
      state as never,
      { command: 'github', action: 'deleteRelease', repo: 'owner/repo' } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Usage') }),
    );
  });

  it('deleteRelease looks up the release by tag and deletes it', async () => {
    await handleGitHubCommand(
      state as never,
      { command: 'github', action: 'deleteRelease', repo: 'owner/repo', tag: 'v1.0.0' } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'githubResult',
        githubAction: 'deleteRelease',
        githubData: expect.stringContaining('v1.0.0'),
      }),
    );
  });

  it('browse posts the repo contents at the requested path', async () => {
    await handleGitHubCommand(
      state as never,
      { command: 'github', action: 'browse', repo: 'owner/repo', ghPath: 'src/' } as never,
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'githubResult', githubAction: 'browse' }),
    );
  });

  it('posts an error when no GitHub remote is available and no repo is supplied', async () => {
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { getRemoteUrl: vi.fn().mockResolvedValue(null) };
    } as never);
    await handleGitHubCommand(state as never, { command: 'github', action: 'listPRs' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('No GitHub remote') }),
    );
  });

  it('posts an error when the remote URL does not parse as a GitHub repo', async () => {
    const { GitHubAPI } = await import('../../github/api.js');
    const { GitCLI } = await import('../../github/git.js');
    vi.mocked(GitCLI).mockImplementationOnce(function () {
      return { getRemoteUrl: vi.fn().mockResolvedValue('ssh://weird-host/foo') };
    } as never);
    vi.mocked(GitHubAPI.parseRepo).mockReturnValueOnce(null);
    await handleGitHubCommand(state as never, { command: 'github', action: 'listPRs' } as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Could not parse remote') }),
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
