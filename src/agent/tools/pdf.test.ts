import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SourceDocument } from '../../sources/types.js';

// Default mock: two chunks. Tests override via mockExtract.mockImplementation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExtract = vi.fn() as any;
const mockCanHandle = vi.fn((uri: string) => uri.endsWith('.pdf'));

vi.mock('../../sources/pdfSource.js', () => ({
  PdfSource: class MockPdfSource {
    sourceType = 'pdf' as const;
    canHandle(uri: string) {
      return mockCanHandle(uri);
    }
    extract(uri: string, signal?: AbortSignal) {
      return mockExtract(uri, signal);
    }
  },
  chunkText: vi.fn((t: string) => (t ? [t] : [])),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'abcdef123456789012'),
  })),
}));

vi.mock('./shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared.js')>();
  return { ...actual, getRoot: vi.fn().mockReturnValue('/workspace') };
});

import * as nodefs from 'node:fs/promises';
import { pdfTools } from './pdf.js';

const mockWriteFile = vi.mocked(nodefs.writeFile);

const readPdfExecutor = pdfTools.find((t) => t.definition.name === 'read_pdf')!.executor;
const indexPdfExecutor = pdfTools.find((t) => t.definition.name === 'index_pdf')!.executor;

describe('read_pdf tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanHandle.mockImplementation((uri: string) => uri.endsWith('.pdf'));
    mockExtract.mockImplementation(async function* (): AsyncGenerator<SourceDocument> {
      yield {
        id: 'pdf:x:0',
        title: 'My Paper',
        content: 'Hello PDF world.',
        metadata: { numpages: 3, filePath: 'x' },
        sourceType: 'pdf',
        uri: 'x',
        chunkIndex: 0,
      };
    });
  });

  it('returns error when path is missing', async () => {
    const result = await readPdfExecutor({});
    expect(result).toContain('Error');
  });

  it('returns error for non-PDF path', async () => {
    mockCanHandle.mockReturnValue(false);
    const result = await readPdfExecutor({ path: 'doc.txt' });
    expect(result).toContain('Error');
  });

  it('returns extracted text with title and page count', async () => {
    const result = await readPdfExecutor({ path: 'paper.pdf' });
    expect(result).toContain('My Paper');
    expect(result).toContain('Pages: 3');
    expect(result).toContain('Hello PDF world.');
  });

  it('truncates and adds notice when text exceeds 8K chars', async () => {
    mockExtract.mockImplementation(async function* (): AsyncGenerator<SourceDocument> {
      yield {
        id: 'pdf:x:0',
        title: 'Big',
        content: 'x'.repeat(10_000),
        metadata: { numpages: 1 },
        sourceType: 'pdf',
        uri: 'x',
        chunkIndex: 0,
      };
    });
    const result = await readPdfExecutor({ path: 'big.pdf' });
    expect(result).toContain('Truncated');
    expect(result.length).toBeLessThan(9_500);
  });

  it('surfaces extraction errors', async () => {
    mockExtract.mockImplementation(async function* (): AsyncGenerator<SourceDocument> {
      throw new Error('corrupt PDF');
      yield {} as never;
    });
    const result = await readPdfExecutor({ path: 'bad.pdf' });
    expect(result).toContain('Error');
  });
});

describe('index_pdf tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanHandle.mockImplementation((uri: string) => uri.endsWith('.pdf'));
    mockExtract.mockImplementation(async function* (): AsyncGenerator<SourceDocument> {
      yield { id: 'pdf:x:0', title: 'T', content: 'chunk0', metadata: {}, sourceType: 'pdf', uri: 'x', chunkIndex: 0 };
      yield { id: 'pdf:x:1', title: 'T', content: 'chunk1', metadata: {}, sourceType: 'pdf', uri: 'x', chunkIndex: 1 };
    });
  });

  it('returns error when path is missing', async () => {
    const result = await indexPdfExecutor({});
    expect(result).toContain('Error');
  });

  it('returns error for non-PDF path', async () => {
    mockCanHandle.mockReturnValue(false);
    const result = await indexPdfExecutor({ path: 'doc.txt' });
    expect(result).toContain('Error');
  });

  it('writes a JSON record and reports chunk count', async () => {
    const result = await indexPdfExecutor({ path: 'paper.pdf' });
    expect(result).toContain('2 chunks');
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.chunkCount).toBe(2);
    expect(written.chunks).toHaveLength(2);
  });

  it('includes uri and basename in the persisted record', async () => {
    await indexPdfExecutor({ path: 'paper.pdf' });
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.basename).toBe('paper.pdf');
    expect(written.uri).toContain('paper.pdf');
  });

  it('surfaces extraction errors', async () => {
    mockExtract.mockImplementation(async function* (): AsyncGenerator<SourceDocument> {
      throw new Error('parse error');
      yield {} as never;
    });
    const result = await indexPdfExecutor({ path: 'bad.pdf' });
    expect(result).toContain('Error');
  });
});
