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

import { replyPrComment, submitPrReview, githubTools } from './github.js';
import { GitHubAPI } from '../../github/api.js';
import { GitCLI } from '../../github/git.js';

const MockGitHubAPI = GitHubAPI as unknown as { parseRepo: ReturnType<typeof vi.fn> };
const MockGitCLI = GitCLI as unknown as ReturnType<typeof vi.fn>;

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

describe('githubTools', () => {
  it('exports reply_pr_comment and submit_pr_review', () => {
    const names = githubTools.map((t) => t.definition.name);
    expect(names).toContain('reply_pr_comment');
    expect(names).toContain('submit_pr_review');
  });

  it('both tools require approval', () => {
    for (const tool of githubTools) {
      expect(tool.requiresApproval).toBe(true);
    }
  });
});
