import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ZoteroItem } from '../../sources/zoteroSource.js';

// ---------------------------------------------------------------------------
// Mock settings
// ---------------------------------------------------------------------------

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from '../../config/settings.js';
const mockGetConfig = vi.mocked(getConfig);

function withZotero(overrides: Record<string, unknown> = {}) {
  mockGetConfig.mockReturnValue({
    zoteroUserId: '12345',
    zoteroApiKey: 'testapikey',
    zoteroBaseUrl: 'https://api.zotero.org',
    ...overrides,
  } as ReturnType<typeof getConfig>);
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(key = 'ABCD1234', title = 'Test Paper'): ZoteroItem {
  return {
    key,
    data: {
      key,
      itemType: 'journalArticle',
      title,
      creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
      abstractNote: 'This paper presents a novel approach to the problem.',
      publicationTitle: 'Science',
      volume: '1',
      issue: '2',
      pages: '10-20',
      date: '2023-06-01',
      DOI: '10.1234/test',
      url: 'https://example.com/paper',
      tags: [{ tag: 'ml' }],
    },
  };
}

// ---------------------------------------------------------------------------
// Import tools after mocks are set up
// ---------------------------------------------------------------------------

import { zoteroTools } from './zotero.js';

const searchTool = zoteroTools.find((t) => t.definition.name === 'zotero_search')!;
const getTool = zoteroTools.find((t) => t.definition.name === 'zotero_get_item')!;

// ---------------------------------------------------------------------------
// zotero_search
// ---------------------------------------------------------------------------

describe('zotero_search tool', () => {
  it('returns error when query is missing', async () => {
    withZotero();
    const result = await searchTool.executor({}, undefined as never);
    expect(result).toContain('Error');
    expect(result).toContain('query');
  });

  it('returns config error when credentials not set', async () => {
    mockGetConfig.mockReturnValue({ zoteroUserId: '', zoteroApiKey: '', zoteroBaseUrl: '' } as ReturnType<
      typeof getConfig
    >);
    const result = await searchTool.executor({ query: 'transformer' }, undefined as never);
    expect(result).toContain('not configured');
  });

  it('returns formatted results on success', async () => {
    withZotero();
    mockFetch.mockResolvedValue({ ok: true, json: async () => [makeItem()] });
    const result = await searchTool.executor({ query: 'transformer' }, undefined as never);
    expect(result).toContain('Test Paper');
    expect(result).toContain('ABCD1234');
    expect(result).toContain('Doe, Jane');
    expect(result).toContain('2023');
  });

  it('returns "no items found" when API returns empty array', async () => {
    withZotero();
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    const result = await searchTool.executor({ query: 'obscure topic' }, undefined as never);
    expect(result).toContain('No items found');
  });

  it('clamps limit between 1 and 25', async () => {
    withZotero();
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    await searchTool.executor({ query: 'test', limit: 999 }, undefined as never);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('limit=25');
  });

  it('returns error string on API failure', async () => {
    withZotero();
    mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
    const result = await searchTool.executor({ query: 'test' }, undefined as never);
    expect(result).toContain('Error');
    expect(result).toContain('403');
  });
});

// ---------------------------------------------------------------------------
// zotero_get_item
// ---------------------------------------------------------------------------

describe('zotero_get_item tool', () => {
  it('returns error when key is missing', async () => {
    withZotero();
    const result = await getTool.executor({}, undefined as never);
    expect(result).toContain('Error');
    expect(result).toContain('key');
  });

  it('returns config error when credentials not set', async () => {
    mockGetConfig.mockReturnValue({ zoteroUserId: '', zoteroApiKey: '' } as ReturnType<typeof getConfig>);
    const result = await getTool.executor({ key: 'ABCD1234' }, undefined as never);
    expect(result).toContain('not configured');
  });

  it('returns formatted item details on success', async () => {
    withZotero();
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => makeItem() });
    const result = await getTool.executor({ key: 'ABCD1234' }, undefined as never);
    expect(result).toContain('Test Paper');
    expect(result).toContain('Doe, Jane');
    expect(result).toContain('2023');
    expect(result).toContain('Science');
    expect(result).toContain('10.1234/test');
    expect(result).toContain('## Abstract');
    expect(result).toContain('novel approach');
  });

  it('returns error message when item not found', async () => {
    withZotero();
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    const result = await getTool.executor({ key: 'NOTFOUND' }, undefined as never);
    expect(result).toContain('not found');
  });

  it('returns error string on API failure', async () => {
    withZotero();
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
    const result = await getTool.executor({ key: 'ABCD1234' }, undefined as never);
    expect(result).toContain('Error');
  });
});

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe('zoteroTools metadata', () => {
  it('has two tools registered', () => {
    expect(zoteroTools).toHaveLength(2);
  });

  it('both tools have requiresApproval false', () => {
    for (const tool of zoteroTools) {
      expect(tool.requiresApproval).toBe(false);
    }
  });

  it('descriptions are ≥150 chars and contain an example', () => {
    for (const tool of zoteroTools) {
      expect(tool.definition.description.length).toBeGreaterThanOrEqual(150);
      expect(/example|`[a-z_]+\(/i.test(tool.definition.description)).toBe(true);
    }
  });
});
