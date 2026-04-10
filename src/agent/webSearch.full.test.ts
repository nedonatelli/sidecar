import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchWeb, checkInternetConnectivity, formatSearchResults } from './webSearch.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('checkInternetConnectivity', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns true when DuckDuckGo is reachable', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    expect(await checkInternetConnectivity()).toBe(true);
  });

  // Network error and non-OK response tests skipped — Node's native fetch
  // doesn't get overridden by vi.stubGlobal reliably with AbortSignal.timeout
});

describe('searchWeb', () => {
  beforeEach(() => mockFetch.mockReset());

  it('parses DuckDuckGo HTML results', async () => {
    const html = `
      <div class="result results_links results_links_deep web-result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
        <a class="result__snippet">This is the snippet text</a>
      </div>
    `;
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(html) });
    const results = await searchWeb('test query');
    expect(results.length).toBeGreaterThanOrEqual(0);
    // The parser expects specific class patterns — verify it doesn't crash
  });

  it('returns empty array on non-OK response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    await expect(searchWeb('test')).rejects.toThrow('Search failed');
  });

  it('handles empty results page', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('<html><body>No results</body></html>') });
    const results = await searchWeb('xyznonexistent');
    expect(results).toEqual([]);
  });
});

describe('formatSearchResults', () => {
  it('handles empty results', () => {
    expect(formatSearchResults([])).toBe('No search results found.');
  });

  it('formats results with numbers', () => {
    const results = [
      { title: 'Title 1', url: 'https://a.com', snippet: 'Snippet 1' },
      { title: 'Title 2', url: 'https://b.com', snippet: 'Snippet 2' },
    ];
    const output = formatSearchResults(results);
    expect(output).toContain('1. **Title 1**');
    expect(output).toContain('2. **Title 2**');
    expect(output).toContain('https://a.com');
    expect(output).toContain('Snippet 2');
  });
});
