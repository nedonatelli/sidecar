import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reviewPrComments, formatPrReviewMarkdown, type PrReviewUi, type PrReviewDeps } from './prReview.js';
import type { GitCLI } from '../github/git.js';
import type { GitHubAPI } from '../github/api.js';
import type { PullRequest, PrReviewThread, PrReviewComment } from '../github/types.js';

// ---------------------------------------------------------------------------
// Tests for prReview.ts (v0.69 chunk 2).
//
// Integration through the injectable PrReviewUi + stubbed GitCLI +
// stubbed GitHubAPI. No network, no VS Code, no disk.
// ---------------------------------------------------------------------------

interface FakeUi extends PrReviewUi {
  calls: {
    showInfo: string[];
    showError: string[];
    openPreview: Array<{ content: string; title: string }>;
    showConfirm: Array<{ message: string; options: readonly string[] }>;
    sendToAgent: string[];
  };
  confirmResponses: string[];
}

function makeFakeUi(): FakeUi {
  const calls: FakeUi['calls'] = {
    showInfo: [],
    showError: [],
    openPreview: [],
    showConfirm: [],
    sendToAgent: [],
  };
  const ui: FakeUi = {
    calls,
    confirmResponses: [],
    showInfo(message) {
      calls.showInfo.push(message);
    },
    showError(message) {
      calls.showError.push(message);
    },
    async openPreview(content, title) {
      calls.openPreview.push({ content, title });
    },
    async showConfirm(message, options) {
      calls.showConfirm.push({ message, options });
      return ui.confirmResponses.shift();
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

function makeThread(overrides: Partial<PrReviewThread> & { comments?: PrReviewComment[] } = {}): PrReviewThread {
  return {
    id: 10,
    path: 'src/auth.ts',
    diffHunk: '@@ -40,4 +40,6 @@\n const token = req.headers.authorization;',
    line: 42,
    comments: overrides.comments ?? [makeComment()],
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

function makeDeps(overrides: Partial<PrReviewDeps> = {}): PrReviewDeps {
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

describe('reviewPrComments — bail-out paths', () => {
  it('returns detached-head when current branch is empty', async () => {
    const ui = makeFakeUi();
    const out = await reviewPrComments(makeDeps({ ui, git: makeGit({ branch: '' }) }));
    expect(out.mode).toBe('detached-head');
    expect(ui.calls.showError[0]).toMatch(/detached/i);
  });

  it('returns no-remote when origin is missing', async () => {
    const out = await reviewPrComments(makeDeps({ git: makeGit({ remote: null }) }));
    expect(out.mode).toBe('no-remote');
  });

  it('returns no-remote when origin is a non-GitHub URL', async () => {
    const out = await reviewPrComments(makeDeps({ git: makeGit({ remote: 'https://gitlab.com/org/repo' }) }));
    expect(out.mode).toBe('no-remote');
  });

  it('returns no-pr when no open PR matches the branch', async () => {
    const ui = makeFakeUi();
    const out = await reviewPrComments(makeDeps({ ui, api: makeApi({ prs: [] }) }));
    expect(out.mode).toBe('no-pr');
    if (out.mode === 'no-pr') expect(out.branch).toBe('feature/auth');
    expect(ui.calls.showInfo[0]).toMatch(/No open PR/);
  });

  it('returns no-comments when the PR has no review threads', async () => {
    const ui = makeFakeUi();
    const out = await reviewPrComments(makeDeps({ ui, api: makeApi({ prs: [makePr()], threads: [] }) }));
    expect(out.mode).toBe('no-comments');
    if (out.mode === 'no-comments') expect(out.pr.number).toBe(42);
    expect(ui.calls.showInfo[0]).toMatch(/no review comments/i);
  });
});

// ---------------------------------------------------------------------------
// Rendered path
// ---------------------------------------------------------------------------

describe('reviewPrComments — rendered path', () => {
  it('opens a preview with PR number, branch, and thread content', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Dismiss'];
    const out = await reviewPrComments(makeDeps({ ui, api: makeApi({ prs: [makePr()], threads: [makeThread()] }) }));
    expect(out.mode).toBe('rendered');
    expect(ui.calls.openPreview).toHaveLength(1);
    const content = ui.calls.openPreview[0].content;
    expect(content).toContain('PR Review — #42');
    expect(content).toContain('feature/auth');
    expect(content).toContain('src/auth.ts');
    expect(content).toContain('Consider validating the token format');
  });

  it('uses the first PR when multiple matches exist', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Dismiss'];
    const out = await reviewPrComments(
      makeDeps({
        ui,
        api: makeApi({
          prs: [makePr({ number: 42 }), makePr({ number: 99 })],
          threads: [makeThread()],
        }),
      }),
    );
    if (out.mode === 'rendered') expect(out.pr.number).toBe(42);
  });

  it('sends the full preview to the agent when user picks Send to agent', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Send to agent'];
    const out = await reviewPrComments(makeDeps({ ui, api: makeApi({ prs: [makePr()], threads: [makeThread()] }) }));
    expect(out.mode).toBe('rendered');
    if (out.mode === 'rendered') expect(out.sentToAgent).toBe(true);
    expect(ui.calls.sendToAgent).toHaveLength(1);
    expect(ui.calls.sendToAgent[0]).toContain('PR #42');
    expect(ui.calls.sendToAgent[0]).toContain('review thread');
  });

  it('does not call sendToAgent when the user dismisses', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Dismiss'];
    const out = await reviewPrComments(makeDeps({ ui, api: makeApi({ prs: [makePr()], threads: [makeThread()] }) }));
    if (out.mode === 'rendered') expect(out.sentToAgent).toBe(false);
    expect(ui.calls.sendToAgent).toHaveLength(0);
  });

  it('surfaces sendToAgent throw as showError but still returns rendered', async () => {
    const ui = makeFakeUi();
    ui.confirmResponses = ['Send to agent'];
    ui.sendToAgent = vi.fn().mockRejectedValue(new Error('chat view unavailable'));
    const out = await reviewPrComments(makeDeps({ ui, api: makeApi({ prs: [makePr()], threads: [makeThread()] }) }));
    expect(out.mode).toBe('rendered');
    if (out.mode === 'rendered') expect(out.sentToAgent).toBe(false);
    expect(ui.calls.showError.at(-1)).toMatch(/chat view unavailable/);
  });
});

// ---------------------------------------------------------------------------
// API error propagation
// ---------------------------------------------------------------------------

describe('reviewPrComments — API error propagation', () => {
  it('returns error when listPullRequestsForBranch throws', async () => {
    const ui = makeFakeUi();
    const out = await reviewPrComments(makeDeps({ ui, api: makeApi({ prsError: new Error('403 Forbidden') }) }));
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/403/);
  });

  it('returns error when getPRReviewThreads throws', async () => {
    const ui = makeFakeUi();
    const out = await reviewPrComments(
      makeDeps({ ui, api: makeApi({ prs: [makePr()], threadsError: new Error('rate limited') }) }),
    );
    expect(out.mode).toBe('error');
    if (out.mode === 'error') expect(out.errorMessage).toMatch(/rate limited/);
  });
});

// ---------------------------------------------------------------------------
// formatPrReviewMarkdown
// ---------------------------------------------------------------------------

describe('formatPrReviewMarkdown', () => {
  it('includes the PR number and title in the heading', () => {
    const md = formatPrReviewMarkdown(makePr(), [makeThread()]);
    expect(md).toContain('# PR Review — #42: Fix auth middleware');
  });

  it('includes headBranch, baseBranch, and URL', () => {
    const md = formatPrReviewMarkdown(makePr(), [makeThread()]);
    expect(md).toContain('`feature/auth`');
    expect(md).toContain('`main`');
    expect(md).toContain('https://github.com/owner/repo/pull/42');
  });

  it('groups threads under file headings', () => {
    const threads = [
      makeThread({ id: 1, path: 'src/auth.ts', line: 10, comments: [makeComment({ path: 'src/auth.ts', line: 10 })] }),
      makeThread({
        id: 2,
        path: 'src/index.ts',
        line: 5,
        comments: [makeComment({ id: 20, path: 'src/index.ts', line: 5 })],
      }),
    ];
    const md = formatPrReviewMarkdown(makePr(), threads);
    expect(md).toContain('## src/auth.ts');
    expect(md).toContain('## src/index.ts');
  });

  it('renders the diff hunk in a diff code block', () => {
    const md = formatPrReviewMarkdown(makePr(), [makeThread()]);
    expect(md).toContain('```diff');
    expect(md).toContain('@@ -40,4 +40,6 @@');
  });

  it('renders comment author and body', () => {
    const md = formatPrReviewMarkdown(makePr(), [makeThread()]);
    expect(md).toContain('**reviewer**');
    expect(md).toContain('Consider validating the token format');
  });

  it('indents reply comments with > prefix', () => {
    const root = makeComment({ id: 10, inReplyToId: null, body: 'Root comment' });
    const reply = makeComment({ id: 11, inReplyToId: 10, body: 'Reply comment' });
    const thread = makeThread({ comments: [root, reply] });
    const md = formatPrReviewMarkdown(makePr(), [thread]);
    expect(md).toContain('> **reviewer**');
    expect(md).toContain('Reply comment');
  });

  it('returns thread count line', () => {
    const md = formatPrReviewMarkdown(makePr(), [makeThread(), makeThread({ id: 99 })]);
    expect(md).toContain('2 review thread(s)');
  });
});
