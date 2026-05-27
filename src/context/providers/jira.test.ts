import { describe, it, expect, vi } from 'vitest';
import { fetchJiraIssues } from './jira.js';
import type { ContextProviderConfig } from '../types.js';

const baseConfig: ContextProviderConfig = {
  type: 'jira',
  token: 'test-token',
  baseUrl: 'https://mycompany.atlassian.net',
  filter: 'open',
  maxIssues: 5,
};

function makeIssue(overrides: object = {}) {
  return {
    key: 'PROJ-1',
    fields: {
      summary: 'Fix login bug',
      status: { name: 'In Progress' },
      description: null,
      priority: null,
      labels: [],
      updated: '2024-03-15T10:00:00.000Z',
      issuetype: { name: 'Bug' },
      ...overrides,
    },
  };
}

function makeOkFetch(issues: object[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ issues }),
  });
}

describe('fetchJiraIssues', () => {
  it('returns error when no baseUrl', async () => {
    const config = { ...baseConfig, baseUrl: undefined };
    const mockFetch = vi.fn();
    const result = await fetchJiraIssues(config, mockFetch);
    expect(result.error).toMatch(/baseUrl/);
    expect(result.issues).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns error when no token', async () => {
    // token is required by type but the function checks it at runtime via the config object
    const config = { ...baseConfig, token: '' };
    const mockFetch = vi.fn();
    const result = await fetchJiraIssues(config, mockFetch);
    expect(result.error).toMatch(/token/i);
    expect(result.issues).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps a successful response with ADF description', async () => {
    const issue = makeIssue({
      description: {
        content: [
          { content: [{ text: 'First paragraph ' }, { text: 'continues.' }] },
          { content: [{ text: 'Second paragraph.' }] },
        ],
      },
    });
    const mockFetch = makeOkFetch([issue]);
    const result = await fetchJiraIssues(baseConfig, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe('PROJ-1');
    expect(result.issues[0].title).toBe('Fix login bug');
    expect(result.issues[0].status).toBe('In Progress');
    expect(result.issues[0].body).toContain('First paragraph');
    expect(result.issues[0].body).toContain('Second paragraph');
  });

  it('maps labels, priority, and updatedAt', async () => {
    const issue = makeIssue({
      labels: ['frontend', 'urgent'],
      priority: { name: 'High' },
      updated: '2024-06-01T08:00:00.000Z',
    });
    const mockFetch = makeOkFetch([issue]);
    const result = await fetchJiraIssues(baseConfig, mockFetch);
    const mapped = result.issues[0];
    expect(mapped.labels).toEqual(['frontend', 'urgent']);
    expect(mapped.priority).toBe('High');
    expect(mapped.updatedAt).toBeTruthy();
  });

  it('returns error on non-ok HTTP status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });
    const result = await fetchJiraIssues(baseConfig, mockFetch);
    expect(result.error).toMatch(/401/);
    expect(result.issues).toEqual([]);
  });

  it('returns error on fetch exception', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network timeout'));
    const result = await fetchJiraIssues(baseConfig, mockFetch);
    expect(result.error).toMatch(/Network timeout/);
    expect(result.issues).toEqual([]);
  });

  it('adds assignee = currentUser() JQL clause when filter is assigned', async () => {
    const config = { ...baseConfig, filter: 'assigned' as const };
    const mockFetch = makeOkFetch([]);
    await fetchJiraIssues(config, mockFetch);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    const jql = new URL(calledUrl).searchParams.get('jql') ?? '';
    expect(jql).toContain('assignee = currentUser()');
  });

  it('does not add assignee JQL clause when filter is not assigned', async () => {
    const mockFetch = makeOkFetch([]);
    await fetchJiraIssues(baseConfig, mockFetch);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    const jql = new URL(calledUrl).searchParams.get('jql') ?? '';
    expect(jql).not.toContain('assignee');
  });

  it('adds project JQL clause when project is set', async () => {
    const config = { ...baseConfig, project: 'MYPROJ' };
    const mockFetch = makeOkFetch([]);
    await fetchJiraIssues(config, mockFetch);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    const jql = new URL(calledUrl).searchParams.get('jql') ?? '';
    expect(jql).toContain('project = "MYPROJ"');
  });

  it('omits body when description field is missing', async () => {
    const issue = makeIssue({ description: null });
    const mockFetch = makeOkFetch([issue]);
    const result = await fetchJiraIssues(baseConfig, mockFetch);
    expect(result.issues[0].body).toBeUndefined();
  });

  it('omits body when description content array is empty', async () => {
    const issue = makeIssue({ description: { content: [] } });
    const mockFetch = makeOkFetch([issue]);
    const result = await fetchJiraIssues(baseConfig, mockFetch);
    expect(result.issues[0].body).toBeUndefined();
  });

  it('uses Bearer token in Authorization header', async () => {
    const mockFetch = makeOkFetch([]);
    await fetchJiraIssues(baseConfig, mockFetch);
    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
  });

  it('strips trailing slash from baseUrl before building request URL', async () => {
    const config = { ...baseConfig, baseUrl: 'https://mycompany.atlassian.net/' };
    const mockFetch = makeOkFetch([]);
    await fetchJiraIssues(config, mockFetch);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toMatch(/\/\/rest/);
    expect(calledUrl).toContain('/rest/api/3/search');
  });

  it('truncates long ADF body to 400 chars + ellipsis', async () => {
    const longText = 'x'.repeat(500);
    const issue = makeIssue({
      description: {
        content: [{ content: [{ text: longText }] }],
      },
    });
    const mockFetch = makeOkFetch([issue]);
    const result = await fetchJiraIssues(baseConfig, mockFetch);
    const body = result.issues[0].body ?? '';
    expect(body.length).toBeLessThan(500);
    expect(body).toContain('…');
  });

  it('returns empty issues array when API returns no issues', async () => {
    const mockFetch = makeOkFetch([]);
    const result = await fetchJiraIssues(baseConfig, mockFetch);
    expect(result.issues).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('sets providerLabel from baseUrl hostname', async () => {
    const mockFetch = makeOkFetch([]);
    const result = await fetchJiraIssues(baseConfig, mockFetch);
    expect(result.providerLabel).toContain('mycompany.atlassian.net');
  });
});
