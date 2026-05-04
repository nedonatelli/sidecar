import { DocumentationIndexer, type DocumentationEntry } from '../../config/documentationIndexer.js';
import type { EmbeddingIndex } from '../../config/embeddingIndex.js';
import { FlatVectorStore } from '../../config/vectorStore.js';
import type { Retriever, RetrievalHit } from './retriever.js';

type DocMeta = { entryId: string };

const DIMENSION = 384;
const MAX_CONTENT_CHARS = 500;
const MAX_EMBED_CHARS = 2048;

/**
 * Retriever for the documentation indexer.
 *
 * When an EmbeddingIndex is supplied and the model is ready, entries are
 * embedded lazily (on first retrieve after the indexer is ready) and
 * searched by cosine similarity. New entries added between calls are picked
 * up automatically via the entry-count diff.
 *
 * Falls back to the keyword scorer inside DocumentationIndexer when the
 * model isn't ready yet — same results, lower quality.
 */
export class DocRetriever implements Retriever {
  name = 'docs';
  private store = new FlatVectorStore<DocMeta>(null, {
    dimension: DIMENSION,
    version: 1,
    binFile: '',
    metaFile: '',
  });
  private entryCache = new Map<string, DocumentationEntry>();

  constructor(
    private indexer: DocumentationIndexer,
    private embeddingIndex?: EmbeddingIndex | null,
  ) {}

  isReady(): boolean {
    return this.indexer.isReady();
  }

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    if (!this.isReady()) return [];

    if (this.embeddingIndex?.isReady()) {
      await this.syncIndex();
      if (this.store.size() > 0) {
        const queryVec = await this.embeddingIndex.embed(query);
        if (queryVec) {
          const hits = await this.store.search(queryVec, k);
          return hits.flatMap((h) => {
            const entry = this.entryCache.get(h.metadata.entryId);
            if (!entry) return [];
            return [entryToHit(entry, h.similarity, this.name)];
          });
        }
      }
    }

    return this.indexer.search(query, k).map((e) => entryToHit(e, e.relevanceScore ?? 0, this.name));
  }

  private async syncIndex(): Promise<void> {
    const all = this.indexer.getAll();
    for (const entry of all) {
      if (this.entryCache.has(entry.id)) continue;
      const text = `${entry.title}\n${entry.content}`.slice(0, MAX_EMBED_CHARS);
      const vec = await this.embeddingIndex!.embed(text);
      if (vec) {
        await this.store.upsert({ id: entry.id, vector: vec, metadata: { entryId: entry.id } });
        this.entryCache.set(entry.id, entry);
      }
    }
  }
}

function entryToHit(entry: DocumentationEntry, score: number, source: string): RetrievalHit {
  const content =
    `### ${entry.title}\n` +
    `_From: ${entry.filePath}:${entry.lineNumber}_\n\n` +
    '```\n' +
    entry.content.slice(0, MAX_CONTENT_CHARS) +
    '\n```';
  return {
    id: `docs:${entry.filePath}:${entry.lineNumber}`,
    score,
    content,
    source,
    title: entry.title,
    filePath: entry.filePath,
  };
}
