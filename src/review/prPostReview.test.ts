import { describe, it, expect, vi } from 'vitest';
import { buildPostReviewPrompt, postPrReview } from './prPostReview.js';
import type { PullRequest } from '../github/types.js';
import type { PrPostReviewDeps } from './prPostReview.js';

const basePr: PullRequest = {
  number: 42,
  title: 'Fix auth bug',
  state: 'open',
  draft: false,
  author: 'dev',
  url: 'https://github.com/o/r/pull/42',
  headBranch: 'fix/auth',
  headSha: 'abc123',
  baseBranch: 'main',
  createdAt: '2026-05-05T00:00:00Z',
};

function makeUi() {
  return {
    showInfo: vi.fn(),
    showError: vi.fn(),
    sendToAgent: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// buildPostReviewPrompt
// ---------------------------------------------------------------------------
describe('buildPostReviewPrompt', () => {
  it('includes PR number, title, and branch in the prompt', () => {
    const prompt = buildPostReviewPrompt(basePr, 'diff content');
    expect(prompt).toContain('PR #42');
    expect(prompt).toContain('Fix auth bug');
    expect(prompt).toContain('fix/auth');
    expect(prompt).toContain('main');
  });

  it('includes create_pr_review tool name', () => {
    const prompt = buildPostReviewPrompt(basePr, '');
    expect(prompt).toContain('create_pr_review');
  });

  it('embeds the diff when provided', () => {
    const prompt = buildPostReviewPrompt(basePr, '+ added line\n- removed line');
    expect(prompt).toContain('added line');
    expect(prompt).toContain('removed line');
  });

  it('truncates very long diffs', () => {
    const bigDiff = 'x'.repeat(50_000);
    const prompt = buildPostReviewPrompt(basePr, bigDiff);
    expect(prompt).toContain('truncated');
    // Should not be 50k+ chars longer than the template
    expect(prompt.length).toBeLessThan(45_000);
  });

  it('handles empty diff gracefully', () => {
    const prompt = buildPostReviewPrompt(basePr, '');
    expect(prompt).toContain('no diff available');
  });
});

// ---------------------------------------------------------------------------
// postPrReview
// ---------------------------------------------------------------------------
describe('postPrReview', () => {
  function makeDeps(overrides: Partial<PrPostReviewDeps> = {}): PrPostReviewDeps {
    return {
      ui: makeUi(),
      cwd: '/mock-workspace',
      ...overrides,
    };
  }

  it('returns detached-head when getCurrentBranch returns empty string', async () => {
    const git = { getCurrentBranch: vi.fn(async () => '') } as never;
    const deps = makeDeps({ git });
    const result = await postPrReview(deps);
    expect(result.mode).toBe('detached-head');
    expect(deps.ui.showError).toHaveBeenCalledWith(expect.stringContaining('detached'));
  });

  it('returns no-remote when getRemoteUrl returns null', async () => {
    const git = {
      getCurrentBranch: vi.fn(async () => 'fix/auth'),
      getRemoteUrl: vi.fn(async () => null),
    } as never;
    const deps = makeDeps({ git });
    const result = await postPrReview(deps);
    expect(result.mode).toBe('no-remote');
    expect(deps.ui.showError).toHaveBeenCalledWith(expect.stringContaining('remote'));
  });

  it('returns no-remote when remote is not a GitHub URL', async () => {
    const git = {
      getCurrentBranch: vi.fn(async () => 'fix/auth'),
      getRemoteUrl: vi.fn(async () => 'https://gitlab.com/org/repo'),
    } as never;
    const deps = makeDeps({ git });
    const result = await postPrReview(deps);
    expect(result.mode).toBe('no-remote');
  });

  it('returns no-pr when no open PRs exist for the branch', async () => {
    const git = {
      getCurrentBranch: vi.fn(async () => 'fix/auth'),
      getRemoteUrl: vi.fn(async () => 'https://github.com/o/r'),
      diff: vi.fn(async () => ({ diff: '', summary: '' })),
    } as never;
    const api = { listPullRequestsForBranch: vi.fn(async () => []) } as never;
    const deps = makeDeps({ git, api });
    const result = await postPrReview(deps);
    expect(result.mode).toBe('no-pr');
    if (result.mode === 'no-pr') expect(result.branch).toBe('fix/auth');
    expect(deps.ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('No open PR'));
  });

  it('dispatches agent with prompt containing PR number when PR is found', async () => {
    const git = {
      getCurrentBranch: vi.fn(async () => 'fix/auth'),
      getRemoteUrl: vi.fn(async () => 'https://github.com/o/r'),
      diff: vi.fn(async () => ({ diff: '+ added', summary: '1 file changed' })),
    } as never;
    const api = { listPullRequestsForBranch: vi.fn(async () => [basePr]) } as never;
    const deps = makeDeps({ git, api });
    const result = await postPrReview(deps);
    expect(result.mode).toBe('dispatched');
    expect(deps.ui.sendToAgent).toHaveBeenCalledOnce();
    const prompt = (deps.ui.sendToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('PR #42');
    expect(prompt).toContain('create_pr_review');
  });

  it('still dispatches even when git diff throws', async () => {
    const git = {
      getCurrentBranch: vi.fn(async () => 'fix/auth'),
      getRemoteUrl: vi.fn(async () => 'https://github.com/o/r'),
      diff: vi.fn(async () => {
        throw new Error('not a git repo');
      }),
    } as never;
    const api = { listPullRequestsForBranch: vi.fn(async () => [basePr]) } as never;
    const deps = makeDeps({ git, api });
    const result = await postPrReview(deps);
    expect(result.mode).toBe('dispatched');
    expect(deps.ui.sendToAgent).toHaveBeenCalled();
  });
});
