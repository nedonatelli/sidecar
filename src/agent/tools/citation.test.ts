import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ZoteroItem } from '../../sources/zoteroSource.js';
import {
  detectStyle,
  bibtexKey,
  formatApa,
  formatMla,
  formatChicago,
  formatBibtex,
  formatLatex,
  formatCitation,
  citationTools,
} from './citation.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<ZoteroItem['data']> = {}): ZoteroItem {
  return {
    key: 'VASWANI17',
    data: {
      key: 'VASWANI17',
      itemType: 'journalArticle',
      title: 'Attention Is All You Need',
      creators: [
        { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
        { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' },
        { creatorType: 'author', firstName: 'Niki', lastName: 'Parmar' },
        { creatorType: 'editor', firstName: 'Ed', lastName: 'Editor' },
      ],
      abstractNote: 'The dominant models are based on complex recurrent networks.',
      publicationTitle: 'Advances in Neural Information Processing Systems',
      volume: '30',
      issue: undefined,
      pages: '5998-6008',
      date: '2017-12-01',
      DOI: '10.48550/arXiv.1706.03762',
      url: 'https://arxiv.org/abs/1706.03762',
      tags: [{ tag: 'transformer' }],
      ...overrides,
    },
  };
}

function singleAuthor(): ZoteroItem {
  return makeItem({
    creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
  });
}

function twoAuthors(): ZoteroItem {
  return makeItem({
    creators: [
      { creatorType: 'author', firstName: 'Alice', lastName: 'Smith' },
      { creatorType: 'author', firstName: 'Bob', lastName: 'Jones' },
    ],
  });
}

function noAuthors(): ZoteroItem {
  return makeItem({ creators: [] });
}

// ---------------------------------------------------------------------------
// detectStyle
// ---------------------------------------------------------------------------

describe('detectStyle', () => {
  it('returns apa for undefined path', () => {
    expect(detectStyle()).toBe('apa');
  });

  it('returns bibtex for .bib files', () => {
    expect(detectStyle('refs.bib')).toBe('bibtex');
    expect(detectStyle('/home/user/citations.bib')).toBe('bibtex');
  });

  it('returns latex for .tex files', () => {
    expect(detectStyle('paper.tex')).toBe('latex');
    expect(detectStyle('paper.ltx')).toBe('latex');
  });

  it('returns apa for .md, .txt, and unknown extensions', () => {
    expect(detectStyle('notes.md')).toBe('apa');
    expect(detectStyle('doc.txt')).toBe('apa');
    expect(detectStyle('paper.docx')).toBe('apa');
  });
});

// ---------------------------------------------------------------------------
// bibtexKey
// ---------------------------------------------------------------------------

describe('bibtexKey', () => {
  it('generates LastnameYear key', () => {
    expect(bibtexKey(makeItem())).toBe('Vaswani2017');
  });

  it('handles single-author item', () => {
    expect(bibtexKey(singleAuthor())).toBe('Doe2017');
  });

  it('handles no-author item gracefully', () => {
    const key = bibtexKey(noAuthors());
    expect(key).toBeTruthy();
    expect(key).toContain('2017');
  });

  it('strips non-alphanumeric characters', () => {
    const item = makeItem({ creators: [{ creatorType: 'author', name: 'Smith & Jones Inc.' }], date: '2020' });
    const key = bibtexKey(item);
    expect(/^[A-Za-z0-9]+$/.test(key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatApa
// ---------------------------------------------------------------------------

describe('formatApa', () => {
  it('formats multiple authors with ampersand before last', () => {
    const result = formatApa(makeItem());
    expect(result).toContain('Vaswani, A.,');
    expect(result).toContain('& Parmar, N.');
  });

  it('formats single author correctly', () => {
    const result = formatApa(singleAuthor());
    expect(result).toContain('Doe, J.');
    expect(result).not.toContain('&');
  });

  it('formats two authors with ampersand', () => {
    const result = formatApa(twoAuthors());
    expect(result).toContain('Smith, A., & Jones, B.');
  });

  it('includes year in parentheses', () => {
    expect(formatApa(makeItem())).toContain('(2017)');
  });

  it('includes journal, volume, pages', () => {
    const result = formatApa(makeItem());
    expect(result).toContain('Advances in Neural Information Processing Systems');
    expect(result).toContain('5998-6008');
  });

  it('appends DOI URL when present', () => {
    expect(formatApa(makeItem())).toContain('https://doi.org/10.48550/arXiv.1706.03762');
  });

  it('appends plain URL when no DOI', () => {
    const result = formatApa(makeItem({ DOI: undefined }));
    expect(result).toContain('https://arxiv.org');
  });

  it('handles no-author items', () => {
    expect(() => formatApa(noAuthors())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatMla
// ---------------------------------------------------------------------------

describe('formatMla', () => {
  it('quotes the title', () => {
    expect(formatMla(makeItem())).toContain('"Attention Is All You Need."');
  });

  it('formats single author as Last, First', () => {
    expect(formatMla(singleAuthor())).toContain('Doe, Jane.');
  });

  it('uses "et al." for 3+ authors', () => {
    expect(formatMla(makeItem())).toContain('et al.');
  });

  it('formats two authors with "and"', () => {
    expect(formatMla(twoAuthors())).toContain(', and Bob Jones.');
  });

  it('includes journal and year', () => {
    const result = formatMla(makeItem());
    expect(result).toContain('Advances in Neural Information Processing Systems');
    expect(result).toContain('2017');
  });
});

// ---------------------------------------------------------------------------
// formatChicago
// ---------------------------------------------------------------------------

describe('formatChicago', () => {
  it('quotes the title', () => {
    expect(formatChicago(makeItem())).toContain('"Attention Is All You Need."');
  });

  it('lists all co-authors after first with "and"', () => {
    const result = formatChicago(makeItem());
    expect(result).toContain('and Noam Shazeer, Niki Parmar');
  });

  it('includes year in parentheses', () => {
    expect(formatChicago(makeItem())).toContain('(2017)');
  });

  it('formats single author correctly', () => {
    const result = formatChicago(singleAuthor());
    expect(result).toContain('Doe, Jane.');
    expect(result).not.toContain('and');
  });
});

// ---------------------------------------------------------------------------
// formatBibtex
// ---------------------------------------------------------------------------

describe('formatBibtex', () => {
  it('starts with @article{Key,', () => {
    const result = formatBibtex(makeItem());
    expect(result).toMatch(/^@article\{Vaswani2017,/);
  });

  it('includes author, title, journal, year', () => {
    const result = formatBibtex(makeItem());
    expect(result).toContain('author');
    expect(result).toContain('Attention Is All You Need');
    expect(result).toContain('year');
    expect(result).toContain('2017');
  });

  it('uses @book for book item types', () => {
    const result = formatBibtex(makeItem({ itemType: 'book' }));
    expect(result).toMatch(/^@book\{/);
  });

  it('converts single dash pages to double dash', () => {
    const result = formatBibtex(makeItem({ pages: '5998-6008' }));
    expect(result).toContain('5998--6008');
  });

  it('omits undefined fields', () => {
    const result = formatBibtex(makeItem({ volume: undefined, issue: undefined }));
    expect(result).not.toContain('number');
  });
});

// ---------------------------------------------------------------------------
// formatLatex
// ---------------------------------------------------------------------------

describe('formatLatex', () => {
  it('returns \\cite{Key}', () => {
    expect(formatLatex(makeItem())).toBe('\\cite{Vaswani2017}');
  });
});

// ---------------------------------------------------------------------------
// formatCitation dispatch
// ---------------------------------------------------------------------------

describe('formatCitation', () => {
  it('dispatches to each style correctly', () => {
    const item = makeItem();
    expect(formatCitation(item, 'apa')).toContain('(2017)');
    expect(formatCitation(item, 'mla')).toContain('"Attention Is All You Need."');
    expect(formatCitation(item, 'chicago')).toContain('"Attention Is All You Need."');
    expect(formatCitation(item, 'bibtex')).toMatch(/^@article\{/);
    expect(formatCitation(item, 'latex')).toBe('\\cite{Vaswani2017}');
  });
});

// ---------------------------------------------------------------------------
// insert_citation tool executor
// ---------------------------------------------------------------------------

vi.mock('../../config/settings.js', () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from '../../config/settings.js';
const mockGetConfig = vi.mocked(getConfig);

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockGetConfig.mockReturnValue({
    zoteroUserId: '12345',
    zoteroApiKey: 'testkey',
    zoteroBaseUrl: 'https://api.zotero.org',
  } as ReturnType<typeof getConfig>);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const insertTool = citationTools[0];

describe('insert_citation tool', () => {
  it('returns error when key is missing', async () => {
    const result = await insertTool.executor({}, undefined as never);
    expect(result).toContain('Error');
    expect(result).toContain('key');
  });

  it('returns error for unknown style', async () => {
    const result = await insertTool.executor({ key: 'X', style: 'harvard' }, undefined as never);
    expect(result).toContain('Error');
    expect(result).toContain('harvard');
  });

  it('returns config error when Zotero not configured', async () => {
    mockGetConfig.mockReturnValue({ zoteroUserId: '', zoteroApiKey: '' } as ReturnType<typeof getConfig>);
    const result = await insertTool.executor({ key: 'ABCD' }, undefined as never);
    expect(result).toContain('not configured');
  });

  it('returns APA citation by default', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => makeItem() });
    const result = await insertTool.executor({ key: 'VASWANI17' }, undefined as never);
    expect(result).toContain('Vaswani, A.');
    expect(result).toContain('(2017)');
  });

  it('respects explicit style parameter', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => makeItem() });
    const result = await insertTool.executor({ key: 'VASWANI17', style: 'bibtex' }, undefined as never);
    expect(result).toMatch(/^@article\{/);
  });

  it('auto-detects bibtex style from .bib file', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => makeItem() });
    const result = await insertTool.executor({ key: 'VASWANI17', file: 'refs.bib' }, undefined as never);
    expect(result).toMatch(/^@article\{/);
  });

  it('auto-detects latex style from .tex file', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => makeItem() });
    const result = await insertTool.executor({ key: 'VASWANI17', file: 'paper.tex' }, undefined as never);
    expect(result).toBe('\\cite{Vaswani2017}');
  });

  it('returns not-found error when item is 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    const result = await insertTool.executor({ key: 'MISSING' }, undefined as never);
    expect(result).toContain('not found');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await insertTool.executor({ key: 'VASWANI17' }, undefined as never);
    expect(result).toContain('Error');
    expect(result).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe('citationTools metadata', () => {
  it('has one tool registered', () => {
    expect(citationTools).toHaveLength(1);
    expect(citationTools[0].definition.name).toBe('insert_citation');
  });

  it('requiresApproval is false', () => {
    expect(citationTools[0].requiresApproval).toBe(false);
  });

  it('description is ≥150 chars and contains an example', () => {
    const desc = citationTools[0].definition.description;
    expect(desc.length).toBeGreaterThanOrEqual(150);
    expect(/example|`[a-z_]+\(/i.test(desc)).toBe(true);
  });
});
