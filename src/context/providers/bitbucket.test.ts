import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { fetchBitbucketPRs } from './bitbucket.js';
import type { ContextProviderConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Tests for bitbucket.ts context provider.
//
// All network calls are stubbed via fetchFn injection. Covers:
//   - missing token
//   - missing project
//   - invalid project format (no slash)
//   - API error response
//   - network throw
//   - successful fetch: maps PRs to ContextIssue[]
//   - basic auth header construction (username:password → Basic base64)
//   - bearer auth header (no colon)
//   - description truncation at 400 chars
//   - empty PRs list
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ContextProviderConfig> = {}): ContextProviderConfig {
  return {
    type: 'bitbucket',
    token: 'myuser:mypassword',
    project: 'myteam/myrepo',
    filter: 'open',
    maxIssues: 5,
    ...overrides,
  };
}

function makePR(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `PR ${id}`,
    state: 'OPEN',
    description: `Description for PR ${id}`,
    links: { html: { href: `https://bitbucket.org/myteam/myrepo/pull-requests/${id}` } },
    author: { display_name: 'Alice' },
    reviewers: [{ display_name: 'Bob' }],
    updated_on: '2026-05-17T10:00:00Z',
    source: { branch: { name: `feature/pr-${id}` } },
    destination: { branch: { name: 'main' } },
    ...overrides,
  };
}

function makeFetch(body: unknown, status = 200): MockedFunction<typeof fetch> {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  })) as unknown as MockedFunction<typeof fetch>;
}

describe('fetchBitbucketPRs — guard paths', () => {
  it('returns error when token is missing', async () => {
    const cfg = makeConfig({ token: '' });
    const result = await fetchBitbucketPRs(cfg, makeFetch({}));
    expect(result.error).toContain('No token');
    expect(result.issues).toHaveLength(0);
  });

  it('returns error when project is missing', async () => {
    const cfg = makeConfig({ project: '' });
    const result = await fetchBitbucketPRs(cfg, makeFetch({}));
    expect(result.error).toContain('No project');
    expect(result.issues).toHaveLength(0);
  });

  it('returns error when project has no slash', async () => {
    const cfg = makeConfig({ project: 'justworkspace' });
    const result = await fetchBitbucketPRs(cfg, makeFetch({}));
    expect(result.error).toContain('Invalid project format');
    expect(result.issues).toHaveLength(0);
  });

  it('returns error on non-2xx API response', async () => {
    const cfg = makeConfig();
    const result = await fetchBitbucketPRs(cfg, makeFetch({}, 401));
    expect(result.error).toContain('401');
    expect(result.issues).toHaveLength(0);
  });

  it('returns error when fetch throws', async () => {
    const cfg = makeConfig();
    const throwFetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await fetchBitbucketPRs(cfg, throwFetch);
    expect(result.error).toContain('network down');
  });

  it('returns error from Bitbucket error body', async () => {
    const cfg = makeConfig();
    const result = await fetchBitbucketPRs(cfg, makeFetch({ error: { message: 'Repository not found' } }));
    expect(result.error).toContain('Repository not found');
  });
});

describe('fetchBitbucketPRs — successful fetch', () => {
  it('maps PRs to ContextIssue with correct fields', async () => {
    const cfg = makeConfig();
    const result = await fetchBitbucketPRs(cfg, makeFetch({ values: [makePR(42)] }));
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.id).toBe('#42');
    expect(issue.title).toBe('PR 42');
    expect(issue.status).toBe('OPEN');
    expect(issue.url).toContain('/42');
    expect(issue.labels).toContain('Bob'); // reviewer mapped to labels
    expect(issue.updatedAt).toBeDefined();
  });

  it('returns empty issues for an empty PRs list', async () => {
    const cfg = makeConfig();
    const result = await fetchBitbucketPRs(cfg, makeFetch({ values: [] }));
    expect(result.issues).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it('truncates description at 400 chars', async () => {
    const longDesc = 'x'.repeat(500);
    const cfg = makeConfig();
    const result = await fetchBitbucketPRs(cfg, makeFetch({ values: [makePR(1, { description: longDesc })] }));
    expect(result.issues[0].body).toHaveLength(401); // 400 + '…'
    expect(result.issues[0].body!.endsWith('…')).toBe(true);
  });

  it('handles PR with no description', async () => {
    const cfg = makeConfig();
    const result = await fetchBitbucketPRs(cfg, makeFetch({ values: [makePR(1, { description: undefined })] }));
    expect(result.issues[0].body).toBeUndefined();
  });

  it('sets providerLabel with workspace/repo', async () => {
    const cfg = makeConfig({ project: 'acme/backend' });
    const result = await fetchBitbucketPRs(cfg, makeFetch({ values: [] }));
    expect(result.providerLabel).toContain('acme/backend');
  });
});

describe('fetchBitbucketPRs — auth header', () => {
  it('sends Basic auth header when token contains colon', async () => {
    const cfg = makeConfig({ token: 'alice:secret123' });
    const fetchSpy = makeFetch({ values: [] });
    await fetchBitbucketPRs(cfg, fetchSpy);
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization'].startsWith('Basic ')).toBe(true);
    // Verify it's valid base64 of "alice:secret123"
    const decoded = Buffer.from(headers['Authorization'].slice(6), 'base64').toString();
    expect(decoded).toBe('alice:secret123');
  });

  it('sends Bearer auth header when token has no colon', async () => {
    const cfg = makeConfig({ token: 'myoauthtoken' });
    const fetchSpy = makeFetch({ values: [] });
    await fetchBitbucketPRs(cfg, fetchSpy);
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer myoauthtoken');
  });
});

describe('fetchBitbucketPRs — custom baseUrl', () => {
  it('uses custom baseUrl for self-hosted Bitbucket Data Center', async () => {
    const cfg = makeConfig({ baseUrl: 'https://bitbucket.company.com' });
    const fetchSpy = makeFetch({ values: [] });
    await fetchBitbucketPRs(cfg, fetchSpy);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url.startsWith('https://bitbucket.company.com')).toBe(true);
  });

  it('defaults to api.bitbucket.org when baseUrl is not set', async () => {
    const cfg = makeConfig({ baseUrl: undefined });
    const fetchSpy = makeFetch({ values: [] });
    await fetchBitbucketPRs(cfg, fetchSpy);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('api.bitbucket.org');
  });
});
