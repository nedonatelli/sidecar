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
});
