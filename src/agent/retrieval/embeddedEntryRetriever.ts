import { createHash } from 'crypto';
import type { EmbeddingIndex } from '../../config/embeddingIndex.js';
import { FlatVectorStore } from '../../config/vectorStore.js';
import type { Retriever, RetrievalHit } from './retriever.js';

const DIMENSION = 384;

/**
 * Base for retrievers over a flat collection of embeddable entries (docs,
 * agent memories). Subclasses supply the entry source, id/embed-text/hit
 * projections, and a keyword fallback; this base owns the vector store, the
 * lazy sync, and the query path.
 *
 * Sync is content-hash aware: an entry is (re)embedded when it is new OR when
 * its embed text changed since the last sync — the previous per-retriever
 * copies keyed only on id and so never picked up an edited entry.
 *
 * The Chunk retriever is intentionally NOT built on this base: it discovers
 * files, chunks them, and prunes on a per-file hash, which is a materially
 * different sync shape.
 */
export abstract class EmbeddedEntryRetriever<TEntry> implements Retriever {
  abstract name: string;

  protected readonly store = new FlatVectorStore<{ entryId: string }>(null, {
    dimension: DIMENSION,
    version: 1,
    binFile: '',
    metaFile: '',
  });
  private readonly cache = new Map<string, { entry: TEntry; hash: string }>();

  constructor(protected readonly embeddingIndex?: EmbeddingIndex | null) {}

  abstract isReady(): boolean;

  /** All entries currently in the source collection. */
  protected abstract getAllEntries(): TEntry[];
  /** Stable identity for an entry (its store key). */
  protected abstract entryId(entry: TEntry): string;
  /** Text embedded + change-detected for an entry (already truncated by the subclass). */
  protected abstract embedText(entry: TEntry): string;
  /** Project an entry + score into a retrieval hit. */
  protected abstract toHit(entry: TEntry, score: number): RetrievalHit;
  /** Keyword fallback used when the embedding model isn't ready. */
  protected abstract fallbackSearch(query: string, k: number): RetrievalHit[];

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    if (!this.isReady()) return [];

    if (this.embeddingIndex?.isReady()) {
      await this.syncIndex();
      if (this.store.size() > 0) {
        const queryVec = await this.embeddingIndex.embed(query);
        if (queryVec) {
          const hits = await this.store.search(queryVec, k);
          return hits.flatMap((h) => {
            const cached = this.cache.get(h.metadata.entryId);
            return cached ? [this.toHit(cached.entry, h.similarity)] : [];
          });
        }
      }
    }

    return this.fallbackSearch(query, k);
  }

  private async syncIndex(): Promise<void> {
    for (const entry of this.getAllEntries()) {
      const id = this.entryId(entry);
      const text = this.embedText(entry);
      const hash = createHash('md5').update(text).digest('hex');
      const existing = this.cache.get(id);
      if (existing && existing.hash === hash) {
        // Content unchanged — refresh the cached entry (mutable fields like a
        // memory's use-count may have moved) but skip the re-embed.
        this.cache.set(id, { entry, hash });
        continue;
      }
      const vec = await this.embeddingIndex!.embed(text);
      if (vec) {
        await this.store.upsert({ id, vector: vec, metadata: { entryId: id } });
        this.cache.set(id, { entry, hash });
      }
    }
  }
}
