import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatSearchResults,
  checkSearchQueryForSecrets,
  searchWeb,
  SearchQueryBlockedError,
  type SearchResult,
} from './webSearch.js';

describe('formatSearchResults', () => {
  it('returns no results message for empty array', () => {
    expect(formatSearchResults([])).toBe('No search results found.');
  });

  it('formats a single result', () => {
    const results: SearchResult[] = [{ title: 'React Docs', url: 'https://react.dev', snippet: 'React is a library' }];
    const formatted = formatSearchResults(results);
    expect(formatted).toContain('1. **React Docs**');
    expect(formatted).toContain('https://react.dev');
    expect(formatted).toContain('React is a library');
  });

  it('formats multiple results with numbered list', () => {
    const results: SearchResult[] = [
      { title: 'First', url: 'https://a.com', snippet: 'A' },
      { title: 'Second', url: 'https://b.com', snippet: 'B' },
      { title: 'Third', url: 'https://c.com', snippet: 'C' },
    ];
    const formatted = formatSearchResults(results);
    expect(formatted).toContain('1. **First**');
    expect(formatted).toContain('2. **Second**');
    expect(formatted).toContain('3. **Third**');
  });
});

describe('checkSearchQueryForSecrets — exfiltration defense', () => {
  it('passes legitimate queries containing word "token" or "secret"', () => {
    // Narrow heuristic: we must not block legitimate programming queries
    // that happen to use these words. Only fully-shaped credentials trip.
    expect(checkSearchQueryForSecrets('how do OAuth tokens work')).toBeNull();
    expect(checkSearchQueryForSecrets('what is a JWT token refresh pattern')).toBeNull();
    expect(checkSearchQueryForSecrets('bcrypt vs argon2 for password hashing')).toBeNull();
    expect(checkSearchQueryForSecrets('react state management best practices')).toBeNull();
  });

  it('blocks queries embedding AWS access keys', () => {
    expect(checkSearchQueryForSecrets('leak: AKIAIOSFODNN7EXAMPLE')).toBe('AWS Access Key');
  });

  it('blocks queries embedding GitHub tokens', () => {
    expect(checkSearchQueryForSecrets('debug ghp_0123456789abcdefghijklmnopqrstuvwxyz')).toBe('GitHub Token');
  });

  it('blocks queries embedding Anthropic API keys', () => {
    expect(checkSearchQueryForSecrets('test sk-ant-api03-abcdefghijklmnopqrstuv')).toBe('Anthropic API Key');
  });

  it('blocks queries embedding OpenAI API keys', () => {
    expect(checkSearchQueryForSecrets('my key is sk-1234567890abcdefghijklmnopqrstuv')).toBe('OpenAI API Key');
  });

  it('blocks queries embedding JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc';
    expect(checkSearchQueryForSecrets(`debug ${jwt}`)).toBe('JWT Token');
  });

  it('blocks queries embedding private key headers', () => {
    expect(checkSearchQueryForSecrets('what does -----BEGIN RSA PRIVATE KEY----- mean')).toBe('Private Key Block');
  });

  it('blocks queries embedding Slack tokens', () => {
    expect(checkSearchQueryForSecrets('debugging xoxb-1234567890-abcdefghij')).toBe('Slack Token');
  });
});

describe('searchWeb — provider dispatch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('throws SearchQueryBlockedError before dispatching when query has a credential', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(searchWeb('AKIAIOSFODNN7EXAMPLE', 'tavily', 'tvly-key')).rejects.toBeInstanceOf(
      SearchQueryBlockedError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('calls Tavily endpoint with the api_key in the body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'Tavily result', url: 'https://example.com', content: 'snippet' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const results = await searchWeb('typescript generics', 'tavily', 'tvly-test');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');
    const body = JSON.parse(init.body as string);
    expect(body.api_key).toBe('tvly-test');
    expect(body.query).toBe('typescript generics');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Tavily result');
    expect(results[0].snippet).toBe('snippet');
  });

  it('throws when Tavily is selected but apiKey is empty', async () => {
    await expect(searchWeb('test', 'tavily', '')).rejects.toThrow('sidecar.webSearch.apiKey');
  });

  it('calls Brave endpoint with X-Subscription-Token header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: { results: [{ title: 'Brave result', url: 'https://brave.com', description: 'brave snippet' }] },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const results = await searchWeb('rust ownership', 'brave', 'BSA-test-key');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api.search.brave.com');
    expect(url).toContain(encodeURIComponent('rust ownership'));
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('BSA-test-key');
    expect(results[0].title).toBe('Brave result');
    expect(results[0].snippet).toBe('brave snippet');
  });

  it('throws when Brave is selected but apiKey is empty', async () => {
    await expect(searchWeb('test', 'brave', '')).rejects.toThrow('sidecar.webSearch.apiKey');
  });

  it('returns empty array when Tavily returns no results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }));
    const results = await searchWeb('obscure query', 'tavily', 'tvly-key');
    expect(results).toEqual([]);
  });
});
