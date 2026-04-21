/**
 * PdfRetriever (v0.75).
 *
 * Keyword/TF-IDF retriever over the on-disk literature index produced by
 * `index_pdf`. Reads every `*.json` file under `.sidecar/literature/`, scores
 * each chunk against the query, and returns the top-k hits.
 *
 * Scoring: term-frequency × inverse-chunk-frequency (IDF over all loaded
 * chunks). Pure in-memory, re-read from disk on each `retrieve()` call so
 * newly indexed PDFs are visible without restarting the extension.
 *
 * No VS Code imports — keeps this testable without the extension host.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Retriever, RetrievalHit } from './retriever.js';
import type { LiteratureRecord } from '../tools/pdf.js';
import type { SourceDocument } from '../../sources/types.js';

// ---------------------------------------------------------------------------
// TF-IDF helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
}

function termFrequency(tokens: string[], term: string): number {
  if (tokens.length === 0) return 0;
  const count = tokens.filter((t) => t === term).length;
  return count / tokens.length;
}

/**
 * Score a single chunk against a list of query terms.
 * Returns the sum of TF × IDF for each query term that appears in the chunk.
 */
function scoreChunk(chunkTokens: string[], queryTerms: string[], idf: Map<string, number>): number {
  let score = 0;
  for (const term of queryTerms) {
    const tf = termFrequency(chunkTokens, term);
    if (tf > 0) {
      score += tf * (idf.get(term) ?? 1);
    }
  }
  return score;
}

/**
 * Compute IDF for each query term across all chunks.
 * idf(t) = log((N + 1) / (df(t) + 1)) + 1  (smoothed to avoid zero-scoring)
 */
function computeIdf(allTokensPerChunk: string[][], queryTerms: string[]): Map<string, number> {
  const N = allTokensPerChunk.length;
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = allTokensPerChunk.filter((tokens) => tokens.includes(term)).length;
    idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
  }
  return idf;
}

// ---------------------------------------------------------------------------
// PdfRetriever
// ---------------------------------------------------------------------------

export class PdfRetriever implements Retriever {
  readonly name = 'literature';

  constructor(private literatureDir: string) {}

  isReady(): boolean {
    return true;
  }

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    const chunks = await this._loadChunks();
    if (chunks.length === 0) return [];

    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0) return [];

    const allTokens = chunks.map((c) => tokenize(c.doc.content));
    const idf = computeIdf(allTokens, queryTerms);

    const scored = chunks.map((c, i) => ({
      chunk: c,
      score: scoreChunk(allTokens[i], queryTerms, idf),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored
      .filter((s) => s.score > 0)
      .slice(0, k)
      .map((s) => this._toHit(s.chunk.doc, s.chunk.basename, s.score));
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async _loadChunks(): Promise<Array<{ doc: SourceDocument; basename: string }>> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.literatureDir);
    } catch {
      return [];
    }

    const jsonFiles = entries.filter((f) => f.endsWith('.json'));
    const results: Array<{ doc: SourceDocument; basename: string }> = [];

    await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const raw = await fs.readFile(path.join(this.literatureDir, file), 'utf8');
          const record = JSON.parse(raw) as LiteratureRecord;
          for (const chunk of record.chunks) {
            results.push({ doc: chunk, basename: record.basename });
          }
        } catch {
          // Skip corrupted index files
        }
      }),
    );

    return results;
  }

  private _toHit(doc: SourceDocument, basename: string, score: number): RetrievalHit {
    const totalChunks = doc.metadata.totalChunks as number | undefined;
    const chunkLabel = totalChunks && totalChunks > 1 ? ` (chunk ${doc.chunkIndex + 1}/${totalChunks})` : '';
    const content = `### ${doc.title}${chunkLabel}\n` + `_Source: ${basename}_\n\n` + doc.content.slice(0, 600);

    return {
      id: doc.id,
      score,
      content,
      source: this.name,
      title: doc.title,
      filePath: doc.uri,
    };
  }
}
