import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZoteroClient, ZoteroSource, formatCreators, itemToDocument } from './zoteroSource.js';
import type { ZoteroItem } from './zoteroSource.js';

function makeItem(overrides: Partial<ZoteroItem['data']> = {}): ZoteroItem {
  return {
    key: 'ABCD1234',
    data: {
      key: 'ABCD1234',
      itemType: 'journalArticle',
      title: 'Attention Is All You Need',
      creators: [
        { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
        { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' },
        { creatorType: 'editor', firstName: 'Ed', lastName: 'Editor' },
      ],
      abstractNote: 'The dominant sequence transduction models are based on complex recurrent networks.',
      publicationTitle: 'NeurIPS',
      volume: '30',
      issue: undefined,
      pages: '5998-6008',
      date: '2017-12-01',
      DOI: '10.48550/arXiv.1706.03762',
      url: 'https://arxiv.org/abs/1706.03762',
      tags: [{ tag: 'transformer' }, { tag: 'attention' }],
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// formatCreators
// ---------------------------------------------------------------------------

describe('formatCreators', () => {
  it('formats author last/first pairs', () => {
    const item = makeItem();
    expect(formatCreators(item.data.creators)).toBe('Vaswani, Ashish; Shazeer, Noam');
  });

  it('excludes non-author creators', () => {
    const creators = [{ creatorType: 'editor', firstName: 'Ed', lastName: 'Smith' }];
    expect(formatCreators(creators)).toBe('');
  });

  it('handles institutional authors (name field)', () => {
    const creators = [{ creatorType: 'author', name: 'Google Brain' }];
    expect(formatCreators(creators)).toBe('Google Brain');
  });

  it('handles empty creators array', () => {
    expect(formatCreators([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// itemToDocument
// ---------------------------------------------------------------------------

describe('itemToDocument', () => {
  it('maps key fields to SourceDocument', () => {
    const doc = itemToDocument(makeItem());
    expect(doc.id).toBe('zotero:ABCD1234');
    expect(doc.title).toBe('Attention Is All You Need');
    expect(doc.sourceType).toBe('zotero');
    expect(doc.uri).toBe('zotero://ABCD1234');
    expect(doc.chunkIndex).toBe(0);
  });

  it('includes abstract in content', () => {
    const doc = itemToDocument(makeItem());
    expect(doc.content).toContain('dominant sequence transduction');
  });

  it('includes citation line in content', () => {
    const doc = itemToDocument(makeItem());
    expect(doc.content).toContain('NeurIPS');
  });

  it('falls back to "(no abstract)" when abstractNote is empty', () => {
    const doc = itemToDocument(makeItem({ abstractNote: '' }));
    expect(doc.content).toContain('(no abstract)');
  });

  it('falls back to "(untitled)" when title is empty', () => {
    const doc = itemToDocument(makeItem({ title: '' }));
    expect(doc.title).toBe('(untitled)');
  });

  it('stores tags in metadata', () => {
    const doc = itemToDocument(makeItem());
    expect(doc.metadata.tags).toEqual(['transformer', 'attention']);
  });
});

// ---------------------------------------------------------------------------
// ZoteroClient
// ---------------------------------------------------------------------------

describe('ZoteroClient', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockClear();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('search sends correct URL and headers', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    const client = new ZoteroClient('12345', 'testkey', 'https://api.zotero.org');
    await client.search('transformer', 5);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/users/12345/items');
    expect(url).toContain('q=transformer');
    expect(url).toContain('limit=5');
    expect(opts.headers['Zotero-API-Key']).toBe('testkey');
    expect(opts.headers['Zotero-API-Version']).toBe('3');
  });

  it('search encodes query correctly', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    const client = new ZoteroClient('1', 'k', 'https://api.zotero.org');
    await client.search('attention & memory');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(encodeURIComponent('attention & memory'));
  });

  it('search throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
    const client = new ZoteroClient('1', 'bad', 'https://api.zotero.org');
    await expect(client.search('test')).rejects.toThrow('403');
  });

  it('getItem returns item on success', async () => {
    const item = makeItem();
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => item });
    const client = new ZoteroClient('1', 'k', 'https://api.zotero.org');
    const result = await client.getItem('ABCD1234');
    expect(result).toEqual(item);
  });

  it('getItem returns null on 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    const client = new ZoteroClient('1', 'k', 'https://api.zotero.org');
    const result = await client.getItem('NOTFOUND');
    expect(result).toBeNull();
  });

  it('getItem throws on other error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    const client = new ZoteroClient('1', 'k', 'https://api.zotero.org');
    await expect(client.getItem('X')).rejects.toThrow('500');
  });
});

// ---------------------------------------------------------------------------
// ZoteroSource
// ---------------------------------------------------------------------------

describe('ZoteroSource', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockClear();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('canHandle returns true for zotero:// URIs', () => {
    const client = new ZoteroClient('1', 'k');
    const source = new ZoteroSource(client);
    expect(source.canHandle('zotero://ABCD1234')).toBe(true);
  });

  it('canHandle returns false for non-zotero URIs', () => {
    const client = new ZoteroClient('1', 'k');
    const source = new ZoteroSource(client);
    expect(source.canHandle('/papers/file.pdf')).toBe(false);
    expect(source.canHandle('https://arxiv.org/abs/1706.03762')).toBe(false);
  });

  it('extract yields a SourceDocument for a valid item', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => makeItem() });
    const client = new ZoteroClient('1', 'k');
    const source = new ZoteroSource(client);
    const docs = [];
    for await (const doc of source.extract('zotero://ABCD1234')) {
      docs.push(doc);
    }
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('zotero:ABCD1234');
    expect(docs[0].sourceType).toBe('zotero');
  });

  it('extract yields nothing for a 404 key', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    const client = new ZoteroClient('1', 'k');
    const source = new ZoteroSource(client);
    const docs = [];
    for await (const doc of source.extract('zotero://MISSING')) {
      docs.push(doc);
    }
    expect(docs).toHaveLength(0);
  });

  it('extract yields nothing for an empty key', async () => {
    const client = new ZoteroClient('1', 'k');
    const source = new ZoteroSource(client);
    const docs = [];
    for await (const doc of source.extract('zotero://')) {
      docs.push(doc);
    }
    expect(docs).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('extract stops early when signal is aborted', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(async () => {
      controller.abort();
      return { ok: true, status: 200, json: async () => makeItem() };
    });
    const client = new ZoteroClient('1', 'k');
    const source = new ZoteroSource(client);
    const docs = [];
    for await (const doc of source.extract('zotero://ABCD1234', controller.signal)) {
      docs.push(doc);
    }
    expect(docs).toHaveLength(0);
  });
});
