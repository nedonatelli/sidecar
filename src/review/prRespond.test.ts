import { describe, it, expect, vi, beforeEach } from 'vitest';
import { respondToPrComments, buildRespondPrompt, type PrRespondUi, type PrRespondDeps } from './prRespond.js';
import type { GitCLI } from '../github/git.js';
import type { GitHubAPI } from '../github/api.js';
import type { PullRequest, PrReviewThread, PrReviewComment } from '../github/types.js';

// ---------------------------------------------------------------------------
// Tests for prRespond.ts (v0.69 chunk 3).
// ---------------------------------------------------------------------------

interface FakeUi extends PrRespondUi {
  calls: {
    showInfo: string[];
    showError: string[];
    sendToAgent: string[];
  };
}

function makeFakeUi(): FakeUi {
  const calls: FakeUi['calls'] = { showInfo: [], showError: [], sendToAgent: [] };
  const ui: FakeUi = {
    calls,
    showInfo(message) {
      calls.showInfo.push(message);
    },
    showError(message) {
      calls.showError.push(message);
    },
    async sendToAgent(prompt) {
      calls.sendToAgent.push(prompt);
    },
  };
  return ui;
}

function makeGit(overrides: { branch?: string; remote?: string | null } = {}): GitCLI {
  return {
    getCurrentBranch: vi.fn().mockResolvedValue(overrides.branch ?? 'feature/auth'),
    getRemoteUrl: vi
      .fn()
      .mockResolvedValue(overrides.remote === undefined ? 'https://github.com/owner/repo.git' : overrides.remote),
  } as unknown as GitCLI;
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: 'Fix auth middleware',
    state: 'open',
    draft: false,
    author: 'dev',
    url: 'https://github.com/owner/repo/pull/42',
    headBranch: 'feature/auth',
    headSha: 'abc123',
    baseBranch: 'main',
    createdAt: '2026-04-19T10:00:00Z',
    ...overrides,
  };
}

function makeComment(overrides: Partial<PrReviewComment> = {}): PrReviewComment {
  return {
    id: 10,
    reviewId: 100,
    inReplyToId: null,
    path: 'src/auth.ts',
    line: 42,
    diffHunk: '@@ -40,4 +40,6 @@\n const token = req.headers.authorization;',
    body: 'Consider validating the token format.',
    author: 'reviewer',
    createdAt: '2026-04-19T11:00:00Z',
    url: 'https://github.com/owner/repo/pull/42#discussion_r10',
    commitSha: 'abc123',
    ...overrides,
  };
}

function makeThread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id: 10,
    path: 'src/auth.ts',
    diffHunk: '@@ -40,4 +40,6 @@\n const token = req.headers.authorization;',
    line: 42,
    comments: [makeComment()],
    ...overrides,
  };
}

function makeApi(overrides: {
  prs?: PullRequest[];
  threads?: PrReviewThread[];
  prsError?: Error;
  threadsError?: Error;
}): GitHubAPI {
  return {
    listPullRequestsForBranch: vi.fn().mockImplementation(async () => {
      if (overrides.prsError) throw overrides.prsError;
      return overrides.prs ?? [];
    }),
    getPRReviewThreads: vi.fn().mockImplementation(async () => {
      if (overrides.threadsError) throw overrides.threadsError;
      return overrides.threads ?? [];
    }),
  } as unknown as GitHubAPI;
}

function makeDeps(overrides: Partial<PrRespondDeps> = {}): PrRespondDeps {
  return {
    ui: makeFakeUi(),
    cwd: '/ws',
    git: makeGit(),
    api: makeApi({}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Bail-out paths
// ---------------------------------------------------------------------------

describe('respondToPrComments — bail-out paths', () => {
  it('returns detached-head when current branch is empty', async () => {
    const ui = makeFakeUi();
    const out = await respondToPrComments(makeDeps({ ui, git: makeGit({ branch: '' }) }));
    expect(out.mode).toBe('detached-head');
    expect(ui.calls.showError[0]).toMatch(/detached/i);
  });

  it('returns no-remote when origin is null', async () => {
    const out = await respondToPrComments(makeDeps({ git: makeGit({ remote: null }) }));
    expect(out.mode).toBe('no-remote');
  });

  it('returns no-remote for non-GitHub URL', async () => {
    const out = await respondToPrComments(makeDeps({ git: makeGit({ remote: 'https://gitlab.com/org/repo' }) }));
    expect(out.mode).toBe('no-remote');
  });

  it('returns no-pr when no open PR matches the branch', async () => {
    const ui = makeFakeUi();
    const out = await respondToPrComments(makeDeps({ ui, api: makeApi({ prs: [] }) }));
    expect(out.mode).toBe('no-pr');
    if (out.mode === 'no-pr') expect(out.branch).toBe('feature/auth');
    expect(ui.calls.showInfo[0]).toMatch(/No open PR/);
  });

  it('returns no-comments when the PR has no review threads', async () => {
    const ui = makeFakeUi();
    const out = await respondToPrComments(makeDeps({ ui, api: makeApi({ prs: [makePr()], threads: [] }) }));
    expect(out.mode).toBe('no-comments');
    if (out.mode === 'no-comments') expect(out.pr.number).toBe(42);
    expect(ui.calls.showInfo[0]).toMatch(/no review comments/i);
  });
});

// ---------------------------------------------------------------------------
// Dispatched path
// ---------------------------------------------------------------------------

describe('respondToPrComments — dispatched path', () => {
  it('returns dispatched with threadCount and fires sendToAgent', async () => {
    const ui = makeFakeUi();
    const out = await respondToPrComments(makeDeps({ ui, api: makeApi({ prs: [makePr()], threads: [makeThread()] }) }));
    expect(out.mode).toBe('dispatched');
    if (out.mode === 'dispatched') {
      expect(out.pr.number).toBe(42);
      expect(out.threadCount).toBe(1);
    }
    expect(ui.calls.sendToAgent).toHaveLength(1);
    expect(ui.calls.showInfo.at(-1)).toMatch(/Agent dispatched/);
  });

  it('prompt contains PR number, branch, and tool call instructions', async () => {
    const ui = makeFakeUi();
    await respondToPrComments(makeDeps({ ui, api: makeApi({ prs: [makePr()], threads: [makeThread()] }) }));
    const prompt = ui.calls.sendToAgent[0];
    expect(prompt).toContain('PR #42');
    expect(prompt).toContain('feature/auth');
    expect(prompt).toContain('reply_pr_comment');
    expect(prompt).toContain('submit_pr_review');
    expect(prompt).toContain('pr_number=42');
  });

  it('returns error when sendToAgent throws', async () => {
    const ui = makeFakeUi();
    ui.sendToAgent = vi.fn().mockRejectedValue(new Error('chat unavailable'));
    const out = await respondToPrComments(makeDeps({ ui, api: makeApi({ prs: [makePr()], threads: [makeThread()] }) }));
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/chat unavailable/);
    expect(ui.calls.showError.at(-1)).toMatch(/chat unavailable/);
  });

  it('selects the first PR when multiple exist', async () => {
    const ui = makeFakeUi();
    const out = await respondToPrComments(
      makeDeps({
        ui,
        api: makeApi({ prs: [makePr({ number: 42 }), makePr({ number: 99 })], threads: [makeThread()] }),
      }),
    );
    if (out.mode === 'dispatched') expect(out.pr.number).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// API error propagation
// ---------------------------------------------------------------------------

describe('respondToPrComments — API errors', () => {
  it('returns error when listPullRequestsForBranch throws', async () => {
    const out = await respondToPrComments(makeDeps({ api: makeApi({ prsError: new Error('401 Unauthorized') }) }));
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/401/);
  });

  it('returns error when getPRReviewThreads throws', async () => {
    const out = await respondToPrComments(
      makeDeps({ api: makeApi({ prs: [makePr()], threadsError: new Error('500') }) }),
    );
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/500/);
  });
});

// ---------------------------------------------------------------------------
// buildRespondPrompt
// ---------------------------------------------------------------------------

describe('buildRespondPrompt', () => {
  it('includes PR number and branch', () => {
    const prompt = buildRespondPrompt(makePr(), [makeThread()]);
    expect(prompt).toContain('PR #42');
    expect(prompt).toContain('feature/auth');
  });

  it('contains reply_pr_comment and submit_pr_review instructions', () => {
    const prompt = buildRespondPrompt(makePr(), [makeThread()]);
    expect(prompt).toContain('reply_pr_comment');
    expect(prompt).toContain('submit_pr_review');
  });

  it('embeds the formatted review markdown', () => {
    const prompt = buildRespondPrompt(makePr(), [makeThread()]);
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('Consider validating the token format');
  });

  it('tells the agent the pr_number to use in tool calls', () => {
    const prompt = buildRespondPrompt(makePr({ number: 77 }), [makeThread()]);
    expect(prompt).toContain('pr_number=77');
  });
});
