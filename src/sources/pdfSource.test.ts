import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chunkText, PdfSource, _setPdfParser } from './pdfSource.js';

// Inject a mock parser directly — avoids loading the 469KB pdf-parse bundle
// in tests that are only exercising chunking / SourceDocument shape logic.
const mockPdfParse = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import * as nodefs from 'node:fs/promises';
const mockReadFile = vi.mocked(nodefs.readFile);

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    const text = 'Short paragraph.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Short paragraph.');
  });

  it('splits on paragraph boundaries', () => {
    // Each para is ~300 tokens (1200 chars); two paras exceed the 500-token target
    const para = (n: number) => `Word${n} `.repeat(200).trim();
    const text = [para(1), para(2), para(3)].join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
    }
  });

  it('carries overlap between chunks', () => {
    // Build text large enough to produce at least two chunks (~2500 tokens)
    const word = 'word ';
    const text = Array.from({ length: 3000 }, () => word).join('') + '\n\nNew section here.';
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The start of the second chunk should overlap with the end of the first
    const endOfFirst = chunks[0].slice(-100);
    expect(chunks[1].slice(0, 200)).toContain(endOfFirst.slice(-20));
  });

  it('handles empty text', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('handles text with only whitespace paragraphs', () => {
    expect(chunkText('   \n\n   \n\n   ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PdfSource
// ---------------------------------------------------------------------------

describe('PdfSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setPdfParser(mockPdfParse);
  });

  afterEach(() => {
    _setPdfParser(null);
  });

  it('canHandle returns true for .pdf paths', () => {
    const source = new PdfSource();
    expect(source.canHandle('paper.pdf')).toBe(true);
    expect(source.canHandle('/abs/path/doc.PDF')).toBe(true);
  });

  it('canHandle returns false for non-PDF paths', () => {
    const source = new PdfSource();
    expect(source.canHandle('readme.md')).toBe(false);
    expect(source.canHandle('data.csv')).toBe(false);
  });

  it('extract emits SourceDocuments for each chunk', async () => {
    mockReadFile.mockResolvedValue(Buffer.from('fake') as never);
    mockPdfParse.mockResolvedValue({
      text: 'Hello world. This is a test PDF.',
      numpages: 1,
      info: { Title: 'Test Paper' },
    });

    const source = new PdfSource();
    const docs = [];
    for await (const doc of source.extract('/papers/test.pdf')) {
      docs.push(doc);
    }

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0].sourceType).toBe('pdf');
    expect(docs[0].title).toBe('Test Paper');
    expect(docs[0].uri).toBe('/papers/test.pdf');
    expect(docs[0].chunkIndex).toBe(0);
    expect(docs[0].id).toBe('pdf:/papers/test.pdf:0');
  });

  it('falls back to basename when PDF has no Title metadata', async () => {
    mockReadFile.mockResolvedValue(Buffer.from('fake') as never);
    mockPdfParse.mockResolvedValue({ text: 'Content here.', numpages: 2, info: {} });

    const source = new PdfSource();
    const docs = [];
    for await (const doc of source.extract('/path/my-paper.pdf')) {
      docs.push(doc);
    }
    expect(docs[0].title).toBe('my-paper');
  });

  it('stops early when signal is aborted before parsing', async () => {
    const controller = new AbortController();
    controller.abort();
    mockReadFile.mockResolvedValue(Buffer.from('fake') as never);

    const source = new PdfSource();
    const docs = [];
    for await (const doc of source.extract('/papers/test.pdf', controller.signal)) {
      docs.push(doc);
    }
    expect(docs).toHaveLength(0);
    expect(mockPdfParse).not.toHaveBeenCalled();
  });

  it('includes numpages and filePath in metadata', async () => {
    mockReadFile.mockResolvedValue(Buffer.from('fake') as never);
    mockPdfParse.mockResolvedValue({ text: 'Text.', numpages: 42, info: {} });

    const source = new PdfSource();
    const docs = [];
    for await (const doc of source.extract('/doc.pdf')) {
      docs.push(doc);
    }
    expect(docs[0].metadata.numpages).toBe(42);
    expect(docs[0].metadata.filePath).toBe('/doc.pdf');
  });
});
