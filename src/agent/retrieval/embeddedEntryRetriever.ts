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
/** Max time a single retrieve() will wait for corpus sync. The in-memory
 *  stores die on every extension-host reload, and syncing inline re-embedded
 *  the FULL corpus on the first query — measured 52s (6,778 doc entries) and
 *  158s (prose chunks) of "Building context…" on this repo. Sync now runs in
 *  the background; the first query searches whatever is embedded within this
 *  budget and the keyword fallback covers the rest of the window. */
export const RETRIEVER_SYNC_BUDGET_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

  private syncPromise: Promise<void> | null = null;

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    if (!this.isReady()) return [];

    if (this.embeddingIndex?.isReady()) {
      // Kick (or join) the background sync, but never block the query on a
      // full corpus re-embed — wait at most the budget, then search what's
      // available. Subsequent queries see progressively more of the corpus.
      this.syncPromise ??= this.syncIndex()
        .catch(() => undefined)
        .finally(() => {
          this.syncPromise = null;
        });
      await Promise.race([this.syncPromise, sleep(RETRIEVER_SYNC_BUDGET_MS)]);
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
