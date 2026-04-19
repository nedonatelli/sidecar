import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubAPI } from './api.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe('GitHubAPI.parseRepo', () => {
  it('parses owner/repo shorthand', () => {
    expect(GitHubAPI.parseRepo('nedonatelli/sidecar')).toEqual({ owner: 'nedonatelli', repo: 'sidecar' });
  });

  it('parses HTTPS URL', () => {
    expect(GitHubAPI.parseRepo('https://github.com/org/repo')).toEqual({ owner: 'org', repo: 'repo' });
  });

  it('parses HTTPS URL with .git', () => {
    expect(GitHubAPI.parseRepo('https://github.com/org/repo.git')).toEqual({ owner: 'org', repo: 'repo' });
  });

  it('parses SSH URL', () => {
    expect(GitHubAPI.parseRepo('git@github.com:org/repo.git')).toEqual({ owner: 'org', repo: 'repo' });
  });

  it('returns null for invalid input', () => {
    expect(GitHubAPI.parseRepo('not-a-repo')).toBeNull();
    expect(GitHubAPI.parseRepo('')).toBeNull();
    expect(GitHubAPI.parseRepo('https://gitlab.com/org/repo')).toBeNull();
  });

  it('handles dots and hyphens in names', () => {
    expect(GitHubAPI.parseRepo('my-org/my.repo-name')).toEqual({ owner: 'my-org', repo: 'my.repo-name' });
  });
});

describe('GitHubAPI methods', () => {
  let api: GitHubAPI;

  beforeEach(() => {
    api = new GitHubAPI('test-token');
    mockFetch.mockReset();
  });

  describe('listPRs', () => {
    it('returns parsed PRs', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse([
          {
            number: 1,
            title: 'Fix bug',
            state: 'open',
            user: { login: 'dev' },
            html_url: 'https://github.com/o/r/pull/1',
            created_at: '2026-01-01',
            body: 'desc',
            head: { ref: 'fix' },
            base: { ref: 'main' },
          },
        ]),
      );
      const prs = await api.listPRs('o', 'r');
      expect(prs).toHaveLength(1);
      expect(prs[0].number).toBe(1);
      expect(prs[0].title).toBe('Fix bug');
      expect(prs[0].author).toBe('dev');
    });
  });

  describe('getPR', () => {
    it('returns a single PR', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          number: 42,
          title: 'Feature',
          state: 'open',
          merged: false,
          user: { login: 'dev' },
          html_url: 'url',
          created_at: '2026-01-01',
          body: 'b',
          head: { ref: 'feat' },
          base: { ref: 'main' },
        }),
      );
      const pr = await api.getPR('o', 'r', 42);
      expect(pr.number).toBe(42);
      expect(pr.state).toBe('open');
    });

    it('returns merged state', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          number: 42,
          title: 'Feature',
          state: 'closed',
          merged: true,
          user: { login: 'dev' },
          html_url: 'url',
          created_at: '2026-01-01',
          head: { ref: 'feat' },
          base: { ref: 'main' },
        }),
      );
      const pr = await api.getPR('o', 'r', 42);
      expect(pr.state).toBe('merged');
    });
  });

  describe('createPR', () => {
    it('creates and returns a PR', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          number: 99,
          title: 'New PR',
          state: 'open',
          user: { login: 'me' },
          html_url: 'url',
          created_at: '2026-01-01',
        }),
      );
      const pr = await api.createPR('o', 'r', 'New PR', 'feat', 'main', 'Body');
      expect(pr.number).toBe(99);
      expect(pr.title).toBe('New PR');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/pulls'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('listIssues', () => {
    it('filters out pull requests', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse([
          {
            number: 1,
            title: 'Bug',
            state: 'open',
            user: { login: 'dev' },
            html_url: 'url',
            labels: [],
            created_at: '2026-01-01',
          },
          {
            number: 2,
            title: 'PR',
            state: 'open',
            user: { login: 'dev' },
            html_url: 'url',
            labels: [],
            created_at: '2026-01-01',
            pull_request: {},
          },
        ]),
      );
      const issues = await api.listIssues('o', 'r');
      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(1);
    });
  });

  describe('createIssue', () => {
    it('creates and returns an issue', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          number: 10,
          title: 'New Issue',
          state: 'open',
          user: { login: 'me' },
          html_url: 'url',
          labels: [],
          created_at: '2026-01-01',
        }),
      );
      const issue = await api.createIssue('o', 'r', 'New Issue', 'Body');
      expect(issue.number).toBe(10);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/issues'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('listReleases', () => {
    it('returns parsed releases', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse([
          {
            id: 1,
            tag_name: 'v1.0',
            name: 'Release 1',
            body: 'Notes',
            draft: false,
            prerelease: false,
            html_url: 'url',
            created_at: '2026-01-01',
            published_at: '2026-01-01',
            assets: [],
          },
        ]),
      );
      const releases = await api.listReleases('o', 'r');
      expect(releases).toHaveLength(1);
      expect(releases[0].tagName).toBe('v1.0');
      expect(releases[0].name).toBe('Release 1');
    });
  });

  describe('getRelease', () => {
    it('gets release by tag', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          id: 1,
          tag_name: 'v2.0',
          name: 'R2',
          body: '',
          draft: false,
          prerelease: true,
          html_url: 'url',
          created_at: '2026-01-01',
          published_at: '',
          assets: [{ name: 'app.zip', size: 1000, browser_download_url: 'dl', download_count: 5 }],
        }),
      );
      const release = await api.getRelease('o', 'r', 'v2.0');
      expect(release.tagName).toBe('v2.0');
      expect(release.prerelease).toBe(true);
      expect(release.assets).toHaveLength(1);
      expect(release.assets[0].name).toBe('app.zip');
      expect(release.assets[0].downloadCount).toBe(5);
    });

    it('falls back to ID endpoint on tag 404', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve('Not found') })
        .mockResolvedValueOnce(
          mockJsonResponse({
            id: 5,
            tag_name: 'v3',
            name: 'R3',
            body: '',
            draft: false,
            prerelease: false,
            html_url: 'url',
            created_at: '2026-01-01',
            published_at: '',
            assets: [],
          }),
        );
      const release = await api.getRelease('o', 'r', '5');
      expect(release.id).toBe(5);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('createRelease', () => {
    it('creates a release with options', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          id: 10,
          tag_name: 'v4.0',
          name: 'V4',
          body: 'notes',
          draft: true,
          prerelease: false,
          html_url: 'url',
          created_at: '2026-01-01',
          published_at: '',
          assets: [],
        }),
      );
      const release = await api.createRelease('o', 'r', { tag: 'v4.0', name: 'V4', body: 'notes', draft: true });
      expect(release.tagName).toBe('v4.0');
      expect(release.draft).toBe(true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tag_name).toBe('v4.0');
      expect(body.draft).toBe(true);
    });
  });

  describe('getLatestRelease', () => {
    it('returns the latest release', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          id: 1,
          tag_name: 'v5.0',
          name: 'Latest',
          body: '',
          draft: false,
          prerelease: false,
          html_url: 'url',
          created_at: '2026-01-01',
          published_at: '2026-01-01',
          assets: [],
        }),
      );
      const release = await api.getLatestRelease('o', 'r');
      expect(release.tagName).toBe('v5.0');
    });
  });

  describe('listRepoContents', () => {
    it('returns parsed file list', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse([
          { name: 'src', type: 'dir', path: 'src', html_url: 'url1' },
          { name: 'README.md', type: 'file', path: 'README.md', html_url: 'url2' },
        ]),
      );
      const files = await api.listRepoContents('o', 'r');
      expect(files).toHaveLength(2);
      expect(files[0].type).toBe('dir');
      expect(files[1].type).toBe('file');
    });
  });

  describe('getBranchProtection', () => {
    it('returns parsed protection rules for a protected branch', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          required_status_checks: { strict: true, contexts: ['lint', 'test'] },
          required_pull_request_reviews: {
            required_approving_review_count: 2,
            require_code_owner_reviews: true,
          },
          required_signatures: { enabled: true },
          enforce_admins: { enabled: true },
          required_linear_history: { enabled: true },
          allow_force_pushes: { enabled: false },
        }),
      );
      const protection = await api.getBranchProtection('o', 'r', 'main');
      expect(protection).not.toBeNull();
      expect(protection!.pullRequestRequired).toBe(true);
      expect(protection!.requiredApprovingReviews).toBe(2);
      expect(protection!.codeOwnersRequired).toBe(true);
      expect(protection!.requiredStatusChecks).toEqual(['lint', 'test']);
      expect(protection!.signedCommitsRequired).toBe(true);
      expect(protection!.enforceAdmins).toBe(true);
      expect(protection!.linearHistoryRequired).toBe(true);
      expect(protection!.forcePushesAllowed).toBe(false);
    });

    it('returns null for an unprotected branch (404)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('{"message":"Branch not protected"}'),
      });
      const protection = await api.getBranchProtection('o', 'r', 'feature');
      expect(protection).toBeNull();
    });

    it('encodes branch names with special characters', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));
      await api.getBranchProtection('o', 'r', 'release/1.0');
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('release%2F1.0');
    });

    it('propagates non-404 errors unchanged', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve('insufficient scope'),
      });
      await expect(api.getBranchProtection('o', 'r', 'main')).rejects.toThrow(/403/);
    });

    it('defaults every rule to off when the payload is a bare object', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));
      const protection = await api.getBranchProtection('o', 'r', 'main');
      expect(protection).toEqual({
        pullRequestRequired: false,
        requiredApprovingReviews: undefined,
        codeOwnersRequired: false,
        requiredStatusChecks: [],
        signedCommitsRequired: false,
        enforceAdmins: false,
        linearHistoryRequired: false,
        forcePushesAllowed: false,
      });
    });
  });

  describe('listWorkflowRuns', () => {
    it('returns parsed runs from the `workflow_runs` envelope', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          workflow_runs: [
            {
              id: 999,
              name: 'CI',
              display_title: 'feat: thing',
              status: 'completed',
              conclusion: 'failure',
              head_branch: 'feature/x',
              head_sha: 'abc',
              html_url: 'https://github.com/o/r/actions/runs/999',
              created_at: '2026-04-18T10:00:00Z',
              updated_at: '2026-04-18T10:05:00Z',
              run_number: 42,
              event: 'push',
            },
          ],
        }),
      );
      const runs = await api.listWorkflowRuns('o', 'r', 'feature/x', 5);
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe(999);
      expect(runs[0].name).toBe('CI');
      expect(runs[0].conclusion).toBe('failure');
      expect(runs[0].runNumber).toBe(42);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('branch=feature%2Fx');
      expect(url).toContain('per_page=5');
    });

    it('falls back to display_title when `name` is null', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: null,
              display_title: 'feat: thing',
              status: 'completed',
              conclusion: 'success',
              head_branch: 'main',
              head_sha: 'abc',
              html_url: 'url',
              created_at: 'c',
              updated_at: 'u',
              run_number: 1,
              event: 'push',
            },
          ],
        }),
      );
      const runs = await api.listWorkflowRuns('o', 'r', 'main');
      expect(runs[0].name).toBe('feat: thing');
    });
  });

  describe('listWorkflowJobs', () => {
    it('returns parsed jobs from the `jobs` envelope with steps', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          jobs: [
            {
              id: 111,
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'url',
              started_at: 'a',
              completed_at: 'b',
              steps: [
                { name: 'checkout', status: 'completed', conclusion: 'success', number: 1 },
                { name: 'npm test', status: 'completed', conclusion: 'failure', number: 2 },
              ],
            },
          ],
        }),
      );
      const jobs = await api.listWorkflowJobs('o', 'r', 999);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].steps).toHaveLength(2);
      expect(jobs[0].steps[1].conclusion).toBe('failure');
    });

    it('defaults steps to [] when the payload omits the field', async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          jobs: [
            {
              id: 1,
              name: 'j',
              status: 'completed',
              conclusion: 'failure',
              html_url: null,
              started_at: null,
              completed_at: null,
            },
          ],
        }),
      );
      const jobs = await api.listWorkflowJobs('o', 'r', 1);
      expect(jobs[0].steps).toEqual([]);
    });
  });

  describe('getJobLogs', () => {
    it('returns the log text on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('raw log body'),
      });
      const log = await api.getJobLogs('o', 'r', 111);
      expect(log).toBe('raw log body');
    });

    it('returns null when the log is 404 (expired)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      });
      const log = await api.getJobLogs('o', 'r', 111);
      expect(log).toBeNull();
    });

    it('returns null when the log is 410 (gone / deleted)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 410,
        text: () => Promise.resolve(''),
      });
      const log = await api.getJobLogs('o', 'r', 111);
      expect(log).toBeNull();
    });

    it('throws on non-404 errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('server error'),
      });
      await expect(api.getJobLogs('o', 'r', 111)).rejects.toThrow(/500/);
    });

    it('sends auth + accept headers on the log request', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });
      await api.getJobLogs('o', 'r', 111);
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer test-token');
      expect(headers.Accept).toBe('application/vnd.github+json');
    });
  });

  describe('error handling', () => {
    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve('rate limited'),
      });
      await expect(api.listPRs('o', 'r')).rejects.toThrow('GitHub API error 403');
    });

    it('includes response body in error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('{"message":"Not Found"}'),
      });
      await expect(api.listIssues('o', 'r')).rejects.toThrow('Not Found');
    });
  });

  describe('auth headers', () => {
    it('sends Bearer token', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([]));
      await api.listPRs('o', 'r');
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer test-token');
      expect(headers.Accept).toBe('application/vnd.github+json');
    });
  });

  // ---------------------------------------------------------------------------
  // PR Review Comments (v0.69 chunk 2)
  // ---------------------------------------------------------------------------

  describe('listPullRequestsForBranch', () => {
    const rawPrFull = {
      number: 7,
      title: 'Refactor auth',
      state: 'open',
      draft: false,
      user: { login: 'dev' },
      html_url: 'https://github.com/o/r/pull/7',
      created_at: '2026-04-19T10:00:00Z',
      body: null,
      head: { ref: 'feature/auth', sha: 'abc123' },
      base: { ref: 'main' },
      merged: false,
    };

    it('returns parsed PullRequest objects', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([rawPrFull]));
      const prs = await api.listPullRequestsForBranch('o', 'r', 'feature/auth');
      expect(prs).toHaveLength(1);
      expect(prs[0].number).toBe(7);
      expect(prs[0].headBranch).toBe('feature/auth');
      expect(prs[0].headSha).toBe('abc123');
      expect(prs[0].baseBranch).toBe('main');
      expect(prs[0].draft).toBe(false);
      expect(prs[0].state).toBe('open');
    });

    it('encodes the branch in the head filter', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([]));
      await api.listPullRequestsForBranch('myorg', 'myrepo', 'feature/my branch');
      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain('head=myorg:feature%2Fmy%20branch');
      expect(url).toContain('state=open');
    });

    it('returns empty array when no PRs match', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([]));
      const prs = await api.listPullRequestsForBranch('o', 'r', 'no-such-branch');
      expect(prs).toEqual([]);
    });

    it('marks merged PR state correctly', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([{ ...rawPrFull, state: 'closed', merged: true }]));
      const prs = await api.listPullRequestsForBranch('o', 'r', 'feature/auth');
      expect(prs[0].state).toBe('merged');
    });
  });

  describe('getPRReviewComments', () => {
    const rawComment = {
      id: 10,
      pull_request_review_id: 100,
      in_reply_to_id: null,
      path: 'src/auth.ts',
      line: 42,
      diff_hunk: '@@ -40,4 +40,6 @@\n const token = req.headers.authorization;',
      body: 'Consider validating the token format.',
      user: { login: 'reviewer' },
      created_at: '2026-04-19T11:00:00Z',
      html_url: 'https://github.com/o/r/pull/7#discussion_r10',
      commit_id: 'abc123',
    };

    it('returns parsed PrReviewComment objects', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([rawComment]));
      const comments = await api.getPRReviewComments('o', 'r', 7);
      expect(comments).toHaveLength(1);
      const c = comments[0];
      expect(c.id).toBe(10);
      expect(c.reviewId).toBe(100);
      expect(c.inReplyToId).toBeNull();
      expect(c.path).toBe('src/auth.ts');
      expect(c.line).toBe(42);
      expect(c.author).toBe('reviewer');
      expect(c.commitSha).toBe('abc123');
    });

    it('maps in_reply_to_id for reply comments', async () => {
      const reply = { ...rawComment, id: 11, in_reply_to_id: 10 };
      mockFetch.mockResolvedValue(mockJsonResponse([rawComment, reply]));
      const comments = await api.getPRReviewComments('o', 'r', 7);
      expect(comments[1].inReplyToId).toBe(10);
    });

    it('handles null user gracefully', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([{ ...rawComment, user: null }]));
      const comments = await api.getPRReviewComments('o', 'r', 7);
      expect(comments[0].author).toBe('unknown');
    });

    it('uses per_page=100 in the request URL', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([]));
      await api.getPRReviewComments('o', 'r', 7);
      expect(mockFetch.mock.calls[0][0]).toContain('per_page=100');
    });
  });

  describe('getPRReviewThreads', () => {
    const root = {
      id: 10,
      pull_request_review_id: 100,
      in_reply_to_id: null,
      path: 'src/auth.ts',
      line: 42,
      diff_hunk: '@@ -40,4 +40,6 @@\n const token = req.headers.authorization;',
      body: 'Root comment',
      user: { login: 'reviewer' },
      created_at: '2026-04-19T11:00:00Z',
      html_url: 'https://github.com/o/r/pull/7#discussion_r10',
      commit_id: 'abc123',
    };
    const reply = { ...root, id: 11, in_reply_to_id: 10, body: 'Reply comment' };
    const otherFile = { ...root, id: 20, path: 'src/index.ts', line: 5 };

    it('groups root comment with its replies into a thread', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([root, reply]));
      const threads = await api.getPRReviewThreads('o', 'r', 7);
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe(10);
      expect(threads[0].comments).toHaveLength(2);
      expect(threads[0].comments[0].body).toBe('Root comment');
      expect(threads[0].comments[1].body).toBe('Reply comment');
    });

    it('creates separate threads for comments on different files', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([root, otherFile]));
      const threads = await api.getPRReviewThreads('o', 'r', 7);
      expect(threads).toHaveLength(2);
      const paths = threads.map((t) => t.path);
      expect(paths).toContain('src/auth.ts');
      expect(paths).toContain('src/index.ts');
    });

    it('sorts threads by file path then line number', async () => {
      const zFile = { ...root, id: 30, path: 'zzz/late.ts', line: 1 };
      const aFile10 = { ...root, id: 40, path: 'aaa/early.ts', line: 10 };
      const aFile5 = { ...root, id: 50, path: 'aaa/early.ts', line: 5 };
      mockFetch.mockResolvedValue(mockJsonResponse([zFile, aFile10, aFile5]));
      const threads = await api.getPRReviewThreads('o', 'r', 7);
      expect(threads[0].path).toBe('aaa/early.ts');
      expect(threads[0].line).toBe(5);
      expect(threads[1].line).toBe(10);
      expect(threads[2].path).toBe('zzz/late.ts');
    });

    it('returns empty array when there are no comments', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse([]));
      const threads = await api.getPRReviewThreads('o', 'r', 7);
      expect(threads).toEqual([]);
    });
  });

  describe('replyToPRComment', () => {
    const rawReply = {
      id: 99,
      pull_request_review_id: null,
      in_reply_to_id: 10,
      path: 'src/auth.ts',
      line: 42,
      diff_hunk: '@@ -40,4 +40,6 @@',
      body: 'Good catch — fixed.',
      user: { login: 'bot' },
      created_at: '2026-04-19T12:00:00Z',
      html_url: 'https://github.com/o/r/pull/7#discussion_r99',
      commit_id: 'abc123',
    };

    it('posts to the replies endpoint and returns parsed comment', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse(rawReply));
      const reply = await api.replyToPRComment('o', 'r', 7, 10, 'Good catch — fixed.');
      expect(reply.id).toBe(99);
      expect(reply.inReplyToId).toBe(10);
      expect(reply.body).toBe('Good catch — fixed.');
    });

    it('uses POST method with JSON body', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse(rawReply));
      await api.replyToPRComment('o', 'r', 7, 10, 'hi');
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/pulls/7/comments/10/replies');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body as string)).toEqual({ body: 'hi' });
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve('Unprocessable') });
      await expect(api.replyToPRComment('o', 'r', 7, 10, 'x')).rejects.toThrow(/422/);
    });
  });

  describe('submitPRReview', () => {
    const rawReview = {
      id: 200,
      body: 'All addressed.',
      state: 'COMMENTED',
      html_url: 'https://github.com/o/r/pull/7#pullrequestreview-200',
      submitted_at: '2026-04-19T12:01:00Z',
    };

    it('posts to the reviews endpoint and returns parsed review', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse(rawReview));
      const review = await api.submitPRReview('o', 'r', 7, 'All addressed.');
      expect(review.id).toBe(200);
      expect(review.state).toBe('COMMENTED');
      expect(review.htmlUrl).toBe('https://github.com/o/r/pull/7#pullrequestreview-200');
      expect(review.submittedAt).toBe('2026-04-19T12:01:00Z');
    });

    it('defaults to COMMENT event', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse(rawReview));
      await api.submitPRReview('o', 'r', 7, 'summary');
      const opts = mockFetch.mock.calls[0][1];
      expect(JSON.parse(opts.body as string)).toEqual({ body: 'summary', event: 'COMMENT' });
    });

    it('passes APPROVE event through', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ ...rawReview, state: 'APPROVED' }));
      await api.submitPRReview('o', 'r', 7, 'LGTM', 'APPROVE');
      const opts = mockFetch.mock.calls[0][1];
      expect(JSON.parse(opts.body as string).event).toBe('APPROVE');
    });

    it('uses POST to the reviews URL', async () => {
      mockFetch.mockResolvedValue(mockJsonResponse(rawReview));
      await api.submitPRReview('o', 'r', 7, 'x');
      expect(mockFetch.mock.calls[0][0]).toContain('/pulls/7/reviews');
      expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('Forbidden') });
      await expect(api.submitPRReview('o', 'r', 7, 'x')).rejects.toThrow(/403/);
    });
  });
});
