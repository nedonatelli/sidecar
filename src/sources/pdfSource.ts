/**
 * PdfSource (v0.75).
 *
 * Extracts text from PDF files using `pdf-parse` and emits one
 * `SourceDocument` per chunk. Chunk boundaries follow a sliding-window
 * strategy: 500-token target size, 50-token overlap, split on paragraph
 * boundaries where possible.
 *
 * No VS Code imports — keeps this testable without the extension host.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Source, SourceDocument } from './types.js';

// Static ESM default import so vi.mock('pdf-parse', ...) can intercept it in
// tests. pdf-parse uses `export =` (CJS), so TypeScript types the default
// import as the namespace object rather than the callable function under
// NodeNext resolution — we cast it explicitly.
import pdfParseLib from 'pdf-parse';
type PdfParseFn = (buf: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, unknown> }>;
const pdfParseFn = pdfParseLib as unknown as PdfParseFn;

async function parsePdf(buffer: Buffer): Promise<{ text: string; numpages: number; info: Record<string, unknown> }> {
  return pdfParseFn(buffer);
}

/** Approximate tokens — 1 token ≈ 4 chars for Latin text. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const CHUNK_TARGET_TOKENS = 500;
const CHUNK_OVERLAP_TOKENS = 50;

/**
 * Split `text` into overlapping chunks of ~CHUNK_TARGET_TOKENS tokens,
 * preferring paragraph boundaries (double newline) as split points.
 */
export function chunkText(text: string): string[] {
  const targetChars = CHUNK_TARGET_TOKENS * 4;
  const overlapChars = CHUNK_OVERLAP_TOKENS * 4;

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;
    if (approxTokens(candidate) <= CHUNK_TARGET_TOKENS || current === '') {
      current = candidate;
    } else {
      chunks.push(current.trim());
      // Carry overlap: last overlapChars of the previous chunk
      const overlap = current.slice(-overlapChars);
      current = overlap + '\n\n' + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Fall back to hard splits if a single paragraph exceeds the target
  const result: string[] = [];
  for (const chunk of chunks) {
    if (approxTokens(chunk) <= CHUNK_TARGET_TOKENS * 2) {
      result.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += targetChars - overlapChars) {
        result.push(chunk.slice(i, i + targetChars).trim());
      }
    }
  }
  return result.filter((c) => c.length > 0);
}

export class PdfSource implements Source {
  readonly sourceType = 'pdf' as const;

  canHandle(uri: string): boolean {
    return uri.toLowerCase().endsWith('.pdf');
  }

  async *extract(uri: string, signal?: AbortSignal): AsyncGenerator<SourceDocument> {
    const buffer = await fs.readFile(uri);
    if (signal?.aborted) return;

    const parsed = await parsePdf(buffer);
    if (signal?.aborted) return;

    const title = (parsed.info?.['Title'] as string | undefined) || path.basename(uri, '.pdf');
    const chunks = chunkText(parsed.text);

    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) return;
      yield {
        id: `pdf:${uri}:${i}`,
        title,
        content: chunks[i],
        metadata: {
          ...parsed.info,
          numpages: parsed.numpages,
          chunkIndex: i,
          totalChunks: chunks.length,
          filePath: uri,
        },
        sourceType: 'pdf',
        uri,
        chunkIndex: i,
      };
    }
  }
}
