import { workspace } from 'vscode';
import { createHash } from 'crypto';
import type { EmbeddingIndex } from '../../config/embeddingIndex.js';
import { FlatVectorStore } from '../../config/vectorStore.js';
import type { Retriever, RetrievalHit } from './retriever.js';
import { chunkText, type TextChunk } from './textChunker.js';
import { RETRIEVER_SYNC_BUDGET_MS } from './embeddedEntryRetriever.js';

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type ChunkMeta = { chunkId: string; filePath: string };

const DIMENSION = 384;

/**
 * Glob patterns for non-code prose files that should participate in RAG.
 * Code files are handled by SemanticRetriever; these patterns cover the
 * docs, notes, and wiki files that code embeddings skip.
 */
export const CHUNK_RETRIEVER_PATTERNS = ['**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst'];

/** Glob patterns excluded from file discovery. */
export const CHUNK_RETRIEVER_EXCLUDE = '{**/node_modules/**,**/.git/**,**/.sidecar/**,**/dist/**,**/build/**}';

/**
 * Maximum files fetched per glob pattern.
 *
 * Deliberately NOT `INDEX_MAX_FILES_PER_PATTERN`, and deliberately low. This
 * runs per query, not once per workspace: it is a latency budget, not a claim
 * to have seen everything. The index scanners were raised to 10,000 and made to
 * report truncation (#40) because a silent cap there produced an incomplete
 * index that answered as if it were complete — but this retriever is already
 * a best-effort ranked sample by construction, so stopping at 200 is the
 * intended behaviour rather than a gap in it.
 *
 * If this ever becomes the backing store for something that must be exhaustive,
 * it needs the shared limit and `indexScanTruncated`, not a bigger number here.
 */
const MAX_FILES_PER_PATTERN = 200;

/**
 * Retriever that chunks prose documents (markdown, plain text, RST) and
 * searches them by cosine similarity via the shared EmbeddingIndex.
 *
 * Files are discovered via `workspace.findFiles`, chunked with `textChunker`,
 * embedded lazily on first retrieve, and content-hashed so unchanged files
 * are not re-embedded on subsequent calls.
 *
 * Returns empty results when the embedding model is not yet ready — the
 * caller (DocRetriever keyword fallback) covers that window.
 */
export class ChunkRetriever implements Retriever {
  name = 'chunks';

  private store = new FlatVectorStore<ChunkMeta>(null, {
    dimension: DIMENSION,
    version: 1,
    binFile: '',
    metaFile: '',
  });
  private chunkCache = new Map<string, TextChunk>();
  private fileHashes = new Map<string, string>();

  constructor(private embeddingIndex: EmbeddingIndex | null) {}

  isReady(): boolean {
    return this.embeddingIndex?.isReady() ?? false;
  }

  private syncPromise: Promise<void> | null = null;

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    if (!this.isReady()) return [];

    // Background sync with a bounded wait — syncing inline re-embedded the
    // whole prose corpus on the first query after every reload (measured
    // 158s on this repo; the store is in-memory and reloads wipe it). The
    // first query searches whatever embedded within the budget; DocRetriever's
    // keyword fallback covers prose during the fill window.
    this.syncPromise ??= this.syncIndex()
      .catch(() => undefined)
      .finally(() => {
        this.syncPromise = null;
      });
    await Promise.race([this.syncPromise, sleepMs(RETRIEVER_SYNC_BUDGET_MS)]);
    if (this.store.size() === 0) return [];

    const queryVec = await this.embeddingIndex!.embed(query);
    if (!queryVec) return [];

    const hits = await this.store.search(queryVec, k);
    return hits.flatMap((h) => {
      const chunk = this.chunkCache.get(h.metadata.chunkId);
      if (!chunk) return [];
      return [chunkToHit(chunk, h.similarity, this.name)];
    });
  }

  private async syncIndex(): Promise<void> {
    const files = await discoverFiles();
    const discoveredPaths = new Set(files.map((f) => f.filePath));

    // Prune chunks for files that are no longer on disk or readable.
    for (const trackedPath of this.fileHashes.keys()) {
      if (!discoveredPaths.has(trackedPath)) {
        await this.store.removeWhere((m) => m.filePath === trackedPath);
        for (const [id, c] of this.chunkCache) {
          if (c.filePath === trackedPath) this.chunkCache.delete(id);
        }
        this.fileHashes.delete(trackedPath);
      }
    }

    for (const { filePath, content } of files) {
      const hash = md5(content);
      if (this.fileHashes.get(filePath) === hash) continue;

      // Remove stale chunks for this file.
      await this.store.removeWhere((m) => m.filePath === filePath);
      for (const [id, c] of this.chunkCache) {
        if (c.filePath === filePath) this.chunkCache.delete(id);
      }

      // Chunk, embed, store.
      const chunks = chunkText(content, filePath);
      for (const chunk of chunks) {
        const vec = await this.embeddingIndex!.embed(chunk.content);
        if (vec) {
          await this.store.upsert({
            id: chunk.id,
            vector: vec,
            metadata: { chunkId: chunk.id, filePath: chunk.filePath },
          });
          this.chunkCache.set(chunk.id, chunk);
        }
      }

      this.fileHashes.set(filePath, hash);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function discoverFiles(): Promise<Array<{ filePath: string; content: string }>> {
  const results: Array<{ filePath: string; content: string }> = [];
  const seen = new Set<string>();

  for (const pattern of CHUNK_RETRIEVER_PATTERNS) {
    let uris;
    try {
      uris = await workspace.findFiles(pattern, CHUNK_RETRIEVER_EXCLUDE, MAX_FILES_PER_PATTERN);
    } catch {
      continue;
    }
    for (const uri of uris) {
      if (seen.has(uri.fsPath)) continue;
      seen.add(uri.fsPath);
      try {
        const bytes = await workspace.fs.readFile(uri);
        results.push({ filePath: uri.fsPath, content: Buffer.from(bytes).toString('utf-8') });
      } catch {
        // unreadable — skip
      }
    }
  }

  return results;
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

const MAX_CONTENT_CHARS = 500;

function chunkToHit(chunk: TextChunk, score: number, source: string): RetrievalHit {
  const location = chunk.heading
    ? `${chunk.filePath}:${chunk.startLine} (${chunk.heading})`
    : `${chunk.filePath}:${chunk.startLine}`;
  const content = `### ${location}\n\n` + '```\n' + chunk.content.slice(0, MAX_CONTENT_CHARS) + '\n```';
  return {
    id: `chunks:${chunk.id}`,
    score,
    content,
    source,
    title: chunk.heading ?? chunk.filePath,
    filePath: chunk.filePath,
  };
}
