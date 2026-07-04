import { AgentMemory, type MemoryEntry } from '../agentMemory.js';
import type { EmbeddingIndex } from '../../config/embeddingIndex.js';
import type { RetrievalHit } from './retriever.js';
import { EmbeddedEntryRetriever } from './embeddedEntryRetriever.js';

const MAX_CONTENT_CHARS = 400;
const MAX_EMBED_CHARS = 2048;

/**
 * Retriever adapter for persistent agent memory.
 *
 * When an EmbeddingIndex is supplied and the model is ready, entries are
 * embedded lazily and searched by cosine similarity; new/edited entries are
 * picked up on the next retrieve (see EmbeddedEntryRetriever). Falls back to
 * AgentMemory.search (keyword heuristic) when the model isn't ready.
 */
export class MemoryRetriever extends EmbeddedEntryRetriever<MemoryEntry> {
  name = 'memory';

  constructor(
    private memory: AgentMemory,
    embeddingIndex?: EmbeddingIndex | null,
  ) {
    super(embeddingIndex);
  }

  isReady(): boolean {
    return true;
  }

  protected getAllEntries(): MemoryEntry[] {
    return this.memory.queryAll();
  }
  protected entryId(entry: MemoryEntry): string {
    return entry.id;
  }
  protected embedText(entry: MemoryEntry): string {
    return `${entry.category}: ${entry.type}\n${entry.content}`.slice(0, MAX_EMBED_CHARS);
  }
  protected toHit(entry: MemoryEntry, score: number): RetrievalHit {
    return entryToHit(entry, score, this.name);
  }
  protected fallbackSearch(query: string, k: number): RetrievalHit[] {
    return this.memory.search(query, undefined, k).map((e) => entryToHit(e, e.relevanceScore ?? 0, this.name));
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
