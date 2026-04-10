import { describe, it, expect } from 'vitest';
import { formatSearchResults, type SearchResult } from './webSearch.js';

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
