import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PdfRetriever } from './pdfRetriever.js';
import type { LiteratureRecord } from '../tools/pdf.js';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

import * as nodefs from 'node:fs/promises';
const mockReaddir = vi.mocked(nodefs.readdir);
const mockReadFile = vi.mocked(nodefs.readFile);

function makeRecord(overrides: Partial<LiteratureRecord> = {}): LiteratureRecord {
  return {
    uri: '/papers/test.pdf',
    basename: 'test.pdf',
    indexedAt: '2024-01-01T00:00:00.000Z',
    chunkCount: 1,
    chunks: [
      {
        id: 'pdf:/papers/test.pdf:0',
        title: 'Test Paper',
        content: 'The quick brown fox jumps over the lazy dog.',
        metadata: { numpages: 5, chunkIndex: 0, totalChunks: 1, filePath: '/papers/test.pdf' },
        sourceType: 'pdf',
        uri: '/papers/test.pdf',
        chunkIndex: 0,
      },
    ],
    ...overrides,
  };
}

describe('PdfRetriever', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('name is "literature"', () => {
    expect(new PdfRetriever('/some/dir').name).toBe('literature');
  });

  it('isReady always returns true', () => {
    expect(new PdfRetriever('/some/dir').isReady()).toBe(true);
  });

  it('returns empty array when directory does not exist', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    const retriever = new PdfRetriever('/missing/dir');
    const hits = await retriever.retrieve('quick fox', 5);
    expect(hits).toEqual([]);
  });

  it('returns empty array when no json files in directory', async () => {
    mockReaddir.mockResolvedValue([] as never);
    const retriever = new PdfRetriever('/lit');
    const hits = await retriever.retrieve('fox', 5);
    expect(hits).toEqual([]);
  });

  it('returns matching hits for a relevant query', async () => {
    mockReaddir.mockResolvedValue(['abc123.json'] as never);
    mockReadFile.mockResolvedValue(JSON.stringify(makeRecord()) as never);

    const retriever = new PdfRetriever('/lit');
    const hits = await retriever.retrieve('quick fox', 5);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe('literature');
    expect(hits[0].title).toBe('Test Paper');
    expect(hits[0].id).toBe('pdf:/papers/test.pdf:0');
    expect(hits[0].content).toContain('Test Paper');
  });

  it('returns no hits when query has no overlap with content', async () => {
    mockReaddir.mockResolvedValue(['abc123.json'] as never);
    mockReadFile.mockResolvedValue(JSON.stringify(makeRecord()) as never);

    const retriever = new PdfRetriever('/lit');
    const hits = await retriever.retrieve('quantum entanglement superconductor', 5);
    expect(hits).toEqual([]);
  });

  it('respects k limit', async () => {
    const record = makeRecord({
      chunkCount: 3,
      chunks: [0, 1, 2].map((i) => ({
        id: `pdf:/p.pdf:${i}`,
        title: 'Paper',
        content: `The quick brown fox chunk number ${i} with fox content`,
        metadata: { numpages: 1, chunkIndex: i, totalChunks: 3, filePath: '/p.pdf' },
        sourceType: 'pdf' as const,
        uri: '/p.pdf',
        chunkIndex: i,
      })),
    });
    mockReaddir.mockResolvedValue(['rec.json'] as never);
    mockReadFile.mockResolvedValue(JSON.stringify(record) as never);

    const retriever = new PdfRetriever('/lit');
    const hits = await retriever.retrieve('fox', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('skips corrupted json files without throwing', async () => {
    mockReaddir.mockResolvedValue(['good.json', 'bad.json'] as never);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(makeRecord()) as never)
      .mockResolvedValueOnce('not valid json {{{{' as never);

    const retriever = new PdfRetriever('/lit');
    const hits = await retriever.retrieve('quick fox', 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('aggregates chunks from multiple index files', async () => {
    const record1 = makeRecord({
      uri: '/a.pdf',
      basename: 'a.pdf',
      chunks: [
        {
          id: 'pdf:/a.pdf:0',
          title: 'Paper A',
          content: 'neural network deep learning transformer model',
          metadata: { numpages: 1, chunkIndex: 0, totalChunks: 1, filePath: '/a.pdf' },
          sourceType: 'pdf',
          uri: '/a.pdf',
          chunkIndex: 0,
        },
      ],
    });
    const record2 = makeRecord({
      uri: '/b.pdf',
      basename: 'b.pdf',
      chunks: [
        {
          id: 'pdf:/b.pdf:0',
          title: 'Paper B',
          content: 'gradient descent optimization loss function',
          metadata: { numpages: 1, chunkIndex: 0, totalChunks: 1, filePath: '/b.pdf' },
          sourceType: 'pdf',
          uri: '/b.pdf',
          chunkIndex: 0,
        },
      ],
    });
    mockReaddir.mockResolvedValue(['a.json', 'b.json'] as never);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(record1) as never)
      .mockResolvedValueOnce(JSON.stringify(record2) as never);

    const retriever = new PdfRetriever('/lit');
    const hits = await retriever.retrieve('neural transformer', 5);
    expect(hits.some((h) => h.title === 'Paper A')).toBe(true);
  });

  it('hit content includes title and chunk source', async () => {
    mockReaddir.mockResolvedValue(['x.json'] as never);
    mockReadFile.mockResolvedValue(JSON.stringify(makeRecord()) as never);

    const retriever = new PdfRetriever('/lit');
    const hits = await retriever.retrieve('fox', 5);

    expect(hits[0].content).toContain('Test Paper');
    expect(hits[0].content).toContain('test.pdf');
  });
});
