import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

import { fetchGitHubIssues } from './github.js';
import { exec } from 'child_process';
import type { ContextProviderConfig } from '../types.js';

const mockExec = exec as unknown as ReturnType<typeof vi.fn>;

const baseConfig: ContextProviderConfig = {
  type: 'github',
  token: 'ghp_test',
  filter: 'open',
  maxIssues: 5,
};

const WORKSPACE = '/workspace/myproject';

function stubExec(stdout: string) {
  mockExec.mockImplementation((_cmd: string, _opts: object, cb: Function) => cb(null, { stdout, stderr: '' }));
}

function makeGHIssue(overrides: object = {}) {
  return {
    number: 42,
    title: 'Bug: crash on startup',
    state: 'open',
    html_url: 'https://github.com/owner/repo/issues/42',
    body: 'Steps to reproduce...',
    labels: [{ name: 'bug' }, { name: 'priority' }],
    updated_at: '2024-05-20T12:00:00Z',
    ...overrides,
  };
}

function makeOkFetch(issues: object[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => issues,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('fetchGitHubIssues', () => {
  it('uses config.project and skips exec when provided', async () => {
    const config = { ...baseConfig, project: 'owner/repo' };
    const mockFetch = makeOkFetch([]);
    await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    expect(mockExec).not.toHaveBeenCalled();
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/repos/owner/repo/issues');
  });

  it('detects repo from https remote URL via exec', async () => {
    stubExec('https://github.com/owner/repo.git\n');
    const mockFetch = makeOkFetch([]);
    await fetchGitHubIssues(baseConfig, WORKSPACE, mockFetch);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/repos/owner/repo/issues');
  });

  it('detects repo from ssh remote URL via exec', async () => {
    stubExec('git@github.com:owner/repo.git\n');
    const mockFetch = makeOkFetch([]);
    await fetchGitHubIssues(baseConfig, WORKSPACE, mockFetch);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/repos/owner/repo/issues');
  });

  it('returns error when exec fails', async () => {
    mockExec.mockImplementation((_cmd: string, _opts: object, cb: Function) => cb(new Error('not a git repo'), null));
    const mockFetch = vi.fn();
    const result = await fetchGitHubIssues(baseConfig, WORKSPACE, mockFetch);
    expect(result.error).toBeTruthy();
    expect(result.issues).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error when exec returns unrecognised remote', async () => {
    stubExec('https://gitlab.com/owner/repo.git\n');
    const mockFetch = vi.fn();
    const result = await fetchGitHubIssues(baseConfig, WORKSPACE, mockFetch);
    expect(result.error).toMatch(/detect/i);
    expect(result.issues).toEqual([]);
  });

  it('returns error when no token configured', async () => {
    const config = { ...baseConfig, project: 'owner/repo', token: '' };
    const mockFetch = vi.fn();
    const result = await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    expect(result.error).toMatch(/token/i);
    expect(result.issues).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps GitHub issues to ContextIssue shape', async () => {
    const config = { ...baseConfig, project: 'owner/repo' };
    const mockFetch = makeOkFetch([makeGHIssue()]);
    const result = await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.id).toBe('#42');
    expect(issue.title).toBe('Bug: crash on startup');
    expect(issue.status).toBe('open');
    expect(issue.body).toContain('Steps to reproduce');
    expect(issue.labels).toEqual(['bug', 'priority']);
    expect(issue.url).toBe('https://github.com/owner/repo/issues/42');
    expect(issue.updatedAt).toBeTruthy();
  });

  it('returns error on non-ok HTTP status', async () => {
    const config = { ...baseConfig, project: 'owner/repo' };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });
    const result = await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    expect(result.error).toMatch(/403/);
    expect(result.issues).toEqual([]);
  });

  it('returns error on fetch exception', async () => {
    const config = { ...baseConfig, project: 'owner/repo' };
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const result = await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    expect(result.error).toMatch(/Connection refused/);
    expect(result.issues).toEqual([]);
  });

  it('adds assignee=@me param when filter is assigned', async () => {
    const config = { ...baseConfig, project: 'owner/repo', filter: 'assigned' as const };
    const mockFetch = makeOkFetch([]);
    await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    const params = new URL(calledUrl).searchParams;
    expect(params.get('assignee')).toBe('@me');
  });

  it('does not add assignee param when filter is not assigned', async () => {
    const config = { ...baseConfig, project: 'owner/repo' };
    const mockFetch = makeOkFetch([]);
    await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    const params = new URL(calledUrl).searchParams;
    expect(params.get('assignee')).toBeNull();
  });

  it('uses baseUrl override instead of api.github.com', async () => {
    const config = {
      ...baseConfig,
      project: 'owner/repo',
      baseUrl: 'https://github.mycompany.com/api/v3',
    };
    const mockFetch = makeOkFetch([]);
    await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('github.mycompany.com/api/v3/repos/owner/repo');
  });

  it('sets providerLabel to GitHub (owner/repo)', async () => {
    const config = { ...baseConfig, project: 'owner/repo' };
    const mockFetch = makeOkFetch([]);
    const result = await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    expect(result.providerLabel).toBe('GitHub (owner/repo)');
  });

  it('truncates long issue body', async () => {
    const config = { ...baseConfig, project: 'owner/repo' };
    const longBody = 'a'.repeat(500);
    const mockFetch = makeOkFetch([makeGHIssue({ body: longBody })]);
    const result = await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    const body = result.issues[0].body ?? '';
    expect(body.length).toBeLessThan(500);
    expect(body).toContain('…');
  });

  it('sets body to undefined when issue body is null', async () => {
    const config = { ...baseConfig, project: 'owner/repo' };
    const mockFetch = makeOkFetch([makeGHIssue({ body: null })]);
    const result = await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    expect(result.issues[0].body).toBeUndefined();
  });

  it('uses Bearer token in Authorization header', async () => {
    const config = { ...baseConfig, project: 'owner/repo' };
    const mockFetch = makeOkFetch([]);
    await fetchGitHubIssues(config, WORKSPACE, mockFetch);
    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ghp_test');
  });
});
