import { AgentMemory, type MemoryEntry } from '../agentMemory.js';
import type { EmbeddingIndex } from '../../config/embeddingIndex.js';
import { FlatVectorStore } from '../../config/vectorStore.js';
import type { Retriever, RetrievalHit } from './retriever.js';

type MemoryMeta = { memoryId: string };

const DIMENSION = 384;
const MAX_CONTENT_CHARS = 400;
const MAX_EMBED_CHARS = 2048;

/**
 * Retriever adapter for persistent agent memory.
 *
 * When an EmbeddingIndex is supplied and the model is ready, entries are
 * embedded lazily on first retrieve and searched by cosine similarity.
 * New entries added between calls are picked up automatically.
 *
 * Falls back to AgentMemory.search (keyword heuristic) when the model
 * isn't ready yet.
 */
export class MemoryRetriever implements Retriever {
  name = 'memory';
  private store = new FlatVectorStore<MemoryMeta>(null, {
    dimension: DIMENSION,
    version: 1,
    binFile: '',
    metaFile: '',
  });
  private entryCache = new Map<string, MemoryEntry>();

  constructor(
    private memory: AgentMemory,
    private embeddingIndex?: EmbeddingIndex | null,
  ) {}

  isReady(): boolean {
    return true;
  }

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    if (this.embeddingIndex?.isReady()) {
      await this.syncIndex();
      if (this.store.size() > 0) {
        const queryVec = await this.embeddingIndex.embed(query);
        if (queryVec) {
          const hits = await this.store.search(queryVec, k);
          return hits.flatMap((h) => {
            const entry = this.entryCache.get(h.metadata.memoryId);
            if (!entry) return [];
            return [entryToHit(entry, h.similarity, this.name)];
          });
        }
      }
    }

    return this.memory.search(query, undefined, k).map((e) => entryToHit(e, e.relevanceScore ?? 0, this.name));
  }

  private async syncIndex(): Promise<void> {
    const all = this.memory.queryAll();
    for (const entry of all) {
      if (this.entryCache.has(entry.id)) continue;
      const text = `${entry.category}: ${entry.type}\n${entry.content}`.slice(0, MAX_EMBED_CHARS);
      const vec = await this.embeddingIndex!.embed(text);
      if (vec) {
        await this.store.upsert({ id: entry.id, vector: vec, metadata: { memoryId: entry.id } });
        this.entryCache.set(entry.id, entry);
      }
    }
  }
}

function entryToHit(entry: MemoryEntry, score: number, source: string): RetrievalHit {
  const useBadge = entry.useCount > 3 ? ` [used ${entry.useCount} times]` : '';
  const typeLabel = entry.type.charAt(0).toUpperCase() + entry.type.slice(1);
  const content = `### ${typeLabel} / ${entry.category}${useBadge}\n${entry.content.slice(0, MAX_CONTENT_CHARS)}`;
  return {
    id: `memory:${entry.id}`,
    score,
    content,
    source,
    title: entry.category,
  };
}
