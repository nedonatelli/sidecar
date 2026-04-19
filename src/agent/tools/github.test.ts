import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for tools/github.ts (v0.69 chunk 3).
//
// GitCLI and GitHubAPI are constructor-mocked. vi.mock factories are hoisted
// to the top of the file so shared state must be declared with vi.hoisted().
// Vitest v4 also requires regular `function` (not arrow) for constructor mocks.
// ---------------------------------------------------------------------------

// Shared mock instance that tests can override per-method.
const mockApiMethods = vi.hoisted(() => ({
  replyToPRComment: vi.fn(),
  submitPRReview: vi.fn(),
  markPrReadyForReview: vi.fn(),
  getPRCheckRuns: vi.fn(),
  listPullRequestsForBranch: vi.fn(),
}));

vi.mock('../../github/auth.js', () => ({
  getGitHubToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../../github/git.js', () => ({
  GitCLI: vi.fn().mockImplementation(function () {
    return {
      getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
      getCurrentBranch: vi.fn().mockResolvedValue('feature/auth'),
    };
  }),
}));

vi.mock('../../github/api.js', () => {
  const GitHubAPI = vi.fn().mockImplementation(function () {
    return mockApiMethods;
  });
  (GitHubAPI as unknown as { parseRepo: (s: string) => unknown }).parseRepo = vi
    .fn()
    .mockReturnValue({ owner: 'owner', repo: 'repo' });
  return { GitHubAPI };
});

import { replyPrComment, submitPrReview, markPrReadyTool, checkPrCiTool, githubTools } from './github.js';
import { GitHubAPI } from '../../github/api.js';
import { GitCLI } from '../../github/git.js';

const MockGitHubAPI = GitHubAPI as unknown as { parseRepo: ReturnType<typeof vi.fn> };
const MockGitCLI = GitCLI as unknown as ReturnType<typeof vi.fn>;

const DEFAULT_PR = {
  number: 42,
  title: 'Fix auth middleware',
  state: 'open' as const,
  draft: false,
  author: 'dev',
  url: 'https://github.com/owner/repo/pull/42',
  headBranch: 'feature/auth',
  headSha: 'abc1234567890',
  baseBranch: 'main',
  createdAt: '2026-04-19T10:00:00Z',
};

const DEFAULT_CHECK_RUN = {
  id: 1,
  name: 'lint',
  status: 'completed',
  conclusion: 'success' as const,
  url: 'https://github.com/owner/repo/actions/runs/1',
  startedAt: '2026-04-19T10:00:00Z',
  completedAt: '2026-04-19T10:05:00Z',
};

const DEFAULT_REPLY = {
  id: 99,
  reviewId: null,
  inReplyToId: 10,
  path: 'src/auth.ts',
  line: 42,
  diffHunk: '',
  body: 'Good catch',
  author: 'bot',
  createdAt: '2026-04-19T12:00:00Z',
  url: 'https://github.com/owner/repo/pull/42#discussion_r99',
  commitSha: 'abc123',
};
const DEFAULT_REVIEW = {
  id: 200,
  body: 'All threads addressed.',
  state: 'COMMENTED',
  htmlUrl: 'https://github.com/owner/repo/pull/42#pullrequestreview-200',
  submittedAt: '2026-04-19T12:01:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApiMethods.replyToPRComment.mockResolvedValue(DEFAULT_REPLY);
  mockApiMethods.submitPRReview.mockResolvedValue(DEFAULT_REVIEW);
  mockApiMethods.markPrReadyForReview.mockResolvedValue({ ...DEFAULT_PR, draft: false });
  mockApiMethods.getPRCheckRuns.mockResolvedValue([DEFAULT_CHECK_RUN]);
  mockApiMethods.listPullRequestsForBranch.mockResolvedValue([DEFAULT_PR]);
  MockGitHubAPI.parseRepo.mockReturnValue({ owner: 'owner', repo: 'repo' });
  MockGitCLI.mockImplementation(function () {
    return {
      getRemoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git'),
      getCurrentBranch: vi.fn().mockResolvedValue('feature/auth'),
    };
  });
  (GitHubAPI as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
    return mockApiMethods;
  });
});

// ---------------------------------------------------------------------------
// reply_pr_comment
// ---------------------------------------------------------------------------

describe('replyPrComment', () => {
  it('posts a reply and returns a confirmation URL', async () => {
    const result = await replyPrComment({ pr_number: 42, comment_id: 10, body: 'Fixed!' });
    expect(result).toContain('Reply posted');
    expect(result).toContain('PR #42');
    expect(result).toContain('comment 10');
    expect(mockApiMethods.replyToPRComment).toHaveBeenCalledWith('owner', 'repo', 42, 10, 'Fixed!');
  });

  it('returns validation error when pr_number is missing', async () => {
    const result = await replyPrComment({ comment_id: 10, body: 'hi' });
    expect(result).toMatch(/requires pr_number/);
  });

  it('returns validation error when comment_id is missing', async () => {
    const result = await replyPrComment({ pr_number: 42, body: 'hi' });
    expect(result).toMatch(/requires pr_number/);
  });

  it('returns validation error when body is missing', async () => {
    const result = await replyPrComment({ pr_number: 42, comment_id: 10 });
    expect(result).toMatch(/requires pr_number/);
  });

  it('returns error message when API call fails', async () => {
    mockApiMethods.replyToPRComment.mockRejectedValueOnce(new Error('403 Forbidden'));
    const result = await replyPrComment({ pr_number: 42, comment_id: 10, body: 'hi' });
    expect(result).toMatch(/Failed to post reply/);
    expect(result).toMatch(/403/);
  });

  it('returns no-remote error when getRemoteUrl returns null', async () => {
    MockGitCLI.mockImplementationOnce(function () {
      return { getRemoteUrl: vi.fn().mockResolvedValue(null) };
    });
    const result = await replyPrComment({ pr_number: 42, comment_id: 10, body: 'hi' });
    expect(result).toMatch(/No "origin" remote/);
  });

  it('returns parse error when remote is not a GitHub URL', async () => {
    MockGitCLI.mockImplementationOnce(function () {
      return { getRemoteUrl: vi.fn().mockResolvedValue('https://gitlab.com/org/repo') };
    });
    MockGitHubAPI.parseRepo.mockReturnValueOnce(null);
    const result = await replyPrComment({ pr_number: 42, comment_id: 10, body: 'hi' });
    expect(result).toMatch(/isn't a GitHub repo/);
  });
});

// ---------------------------------------------------------------------------
// submit_pr_review
// ---------------------------------------------------------------------------

describe('submitPrReview', () => {
  it('submits a review and returns id + state', async () => {
    const result = await submitPrReview({ pr_number: 42, body: 'All done.' });
    expect(result).toContain('id 200');
    expect(result).toContain('COMMENTED');
    expect(mockApiMethods.submitPRReview).toHaveBeenCalledWith('owner', 'repo', 42, 'All done.', 'COMMENT');
  });

  it('passes the event parameter through', async () => {
    await submitPrReview({ pr_number: 42, body: 'LGTM!', event: 'APPROVE' });
    expect(mockApiMethods.submitPRReview).toHaveBeenCalledWith('owner', 'repo', 42, 'LGTM!', 'APPROVE');
  });

  it('defaults to COMMENT when event is omitted', async () => {
    await submitPrReview({ pr_number: 42, body: 'Addressed.' });
    expect(mockApiMethods.submitPRReview).toHaveBeenCalledWith('owner', 'repo', 42, 'Addressed.', 'COMMENT');
  });

  it('returns validation error when pr_number is missing', async () => {
    const result = await submitPrReview({ body: 'hi' });
    expect(result).toMatch(/requires pr_number/);
  });

  it('returns validation error when body is missing', async () => {
    const result = await submitPrReview({ pr_number: 42 });
    expect(result).toMatch(/requires pr_number/);
  });

  it('returns error message when API call fails', async () => {
    mockApiMethods.submitPRReview.mockRejectedValueOnce(new Error('rate limited'));
    const result = await submitPrReview({ pr_number: 42, body: 'hi' });
    expect(result).toMatch(/Failed to submit PR review/);
    expect(result).toMatch(/rate limited/);
  });
});

// ---------------------------------------------------------------------------
// githubTools registry shape
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mark_pr_ready
// ---------------------------------------------------------------------------

describe('markPrReadyTool', () => {
  it('returns confirmation when PR is marked ready', async () => {
    mockApiMethods.listPullRequestsForBranch.mockResolvedValueOnce([{ ...DEFAULT_PR, draft: true }]);
    const result = await markPrReadyTool({});
    expect(result).toContain('ready for review');
    expect(result).toContain('PR #42');
  });

  it('returns already-ready message when PR is not a draft', async () => {
    const result = await markPrReadyTool({});
    expect(result).toMatch(/already ready/i);
  });

  it('returns no-pr message when no PR found', async () => {
    mockApiMethods.listPullRequestsForBranch.mockResolvedValueOnce([]);
    const result = await markPrReadyTool({});
    expect(result).toMatch(/No open PR/);
  });

  it('returns no-remote message when getRemoteUrl returns null', async () => {
    MockGitCLI.mockImplementationOnce(function () {
      return {
        getRemoteUrl: vi.fn().mockResolvedValue(null),
        getCurrentBranch: vi.fn().mockResolvedValue('feature/auth'),
      };
    });
    const result = await markPrReadyTool({});
    expect(result).toMatch(/No "origin" remote/);
  });
});

// ---------------------------------------------------------------------------
// check_pr_ci
// ---------------------------------------------------------------------------

describe('checkPrCiTool', () => {
  it('returns CI check markdown when checks are present', async () => {
    const result = await checkPrCiTool({});
    expect(result).toContain('PR #42');
    expect(result).toContain('lint');
  });

  it('returns no-checks message when there are no runs', async () => {
    mockApiMethods.getPRCheckRuns.mockResolvedValueOnce([]);
    const result = await checkPrCiTool({});
    expect(result).toMatch(/no CI checks/i);
  });

  it('returns no-pr message when no PR found', async () => {
    mockApiMethods.listPullRequestsForBranch.mockResolvedValueOnce([]);
    const result = await checkPrCiTool({});
    expect(result).toMatch(/No open PR/);
  });

  it('returns error message on API failure', async () => {
    mockApiMethods.getPRCheckRuns.mockRejectedValueOnce(new Error('502 Bad Gateway'));
    const result = await checkPrCiTool({});
    expect(result).toMatch(/Failed to fetch CI checks/);
    expect(result).toMatch(/502/);
  });
});

// ---------------------------------------------------------------------------
// githubTools registry shape
// ---------------------------------------------------------------------------

describe('githubTools', () => {
  it('exports reply_pr_comment and submit_pr_review', () => {
    const names = githubTools.map((t) => t.definition.name);
    expect(names).toContain('reply_pr_comment');
    expect(names).toContain('submit_pr_review');
  });

  it('exports mark_pr_ready and check_pr_ci', () => {
    const names = githubTools.map((t) => t.definition.name);
    expect(names).toContain('mark_pr_ready');
    expect(names).toContain('check_pr_ci');
  });

  it('mark_pr_ready and submit_pr_review require approval', () => {
    const approval = githubTools.filter((t) =>
      ['submit_pr_review', 'mark_pr_ready', 'reply_pr_comment'].includes(t.definition.name),
    );
    for (const tool of approval) {
      expect(tool.requiresApproval).toBe(true);
    }
  });

  it('check_pr_ci does not require approval', () => {
    const tool = githubTools.find((t) => t.definition.name === 'check_pr_ci');
    expect(tool?.requiresApproval).toBe(false);
  });
});
