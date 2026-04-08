import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch at module level before any imports that use it
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { extractPinReferences, resolveUrlReferences } from './workspace.js';

describe('extractPinReferences', () => {
  it('extracts single pin reference', () => {
    const pins = extractPinReferences('look at @pin:src/config.ts please');
    expect(pins).toEqual(['src/config.ts']);
  });

  it('extracts multiple pin references', () => {
    const pins = extractPinReferences('@pin:src/a.ts and @pin:src/b.ts');
    expect(pins).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns empty array when no pins', () => {
    const pins = extractPinReferences('no pins here');
    expect(pins).toEqual([]);
  });

  it('handles folder pins', () => {
    const pins = extractPinReferences('@pin:src/config/');
    expect(pins).toEqual(['src/config/']);
  });

  it('stops at whitespace', () => {
    const pins = extractPinReferences('@pin:file.ts more text');
    expect(pins).toEqual(['file.ts']);
  });
});

describe('resolveUrlReferences', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('returns text unchanged when no URLs', async () => {
    const result = await resolveUrlReferences('no urls here');
    expect(result).toBe('no urls here');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches URL and appends readable content', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'text/html' : null) },
      text: async () =>
        '<html><body><p>Hello world, this is a documentation page with enough content to pass the minimum length threshold for inclusion in context.</p></body></html>',
    }));

    const result = await resolveUrlReferences('check https://example.com/docs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('Web Page Context');
    expect(result).toContain('https://example.com/docs');
    expect(result).toContain('Hello world');
  });

  it('strips script and style tags', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'text/html' : null) },
      text: async () =>
        '<html><script>alert("xss")</script><style>.x{}</style><p>Clean text with enough content to pass the fifty character minimum threshold for url context.</p></html>',
    }));

    const result = await resolveUrlReferences('see https://example.com');
    expect(result).toContain('Clean text');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('.x{}');
  });

  it('skips non-ok responses', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false }));

    const result = await resolveUrlReferences('check https://example.com/404');
    expect(result).not.toContain('Web Page Context');
  });

  it('skips non-text content types', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'application/pdf' : null) },
    }));

    const result = await resolveUrlReferences('check https://example.com/file.pdf');
    expect(result).not.toContain('Web Page Context');
  });

  it('limits to 3 URLs per message', async () => {
    for (let i = 0; i < 5; i++) {
      fetchMock.mockImplementationOnce(async () => ({
        ok: true,
        headers: { get: (k: string) => (k === 'content-type' ? 'text/plain' : null) },
        text: async () => `Page ${i} with enough content to pass the 50 char minimum threshold`,
      }));
    }

    await resolveUrlReferences('https://a.com https://b.com https://c.com https://d.com https://e.com');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('handles fetch errors gracefully', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('Network error');
    });

    const result = await resolveUrlReferences('check https://unreachable.com');
    expect(result).not.toContain('Web Page Context');
  });

  it('deduplicates repeated URLs', async () => {
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'text/plain' : null) },
      text: async () => 'content that is long enough to pass the minimum length check for inclusion',
    }));

    await resolveUrlReferences('https://example.com and https://example.com again');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
