import { AgentMemory, MemoryEntry } from '../agentMemory';
import { Retriever, RetrievalHit } from './retriever';

/**
 * Retriever adapter for persistent agent memory.
 *
 * Emits one hit per matched memory so each can be independently fused
 * against documentation hits — the existing `formatForContext` groups
 * by session and type, which works against fusion because fused output
 * may interleave memory with docs.
 */
export class MemoryRetriever implements Retriever {
  name = 'memory';

  constructor(private memory: AgentMemory) {}

  isReady(): boolean {
    return true;
  }

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    const memories = this.memory.search(query, undefined, k);
    return memories.map((entry) => ({
      id: `memory:${entry.id}`,
      score: entry.relevanceScore ?? 0,
      content: renderMemory(entry),
      source: this.name,
      title: entry.category,
    }));
  }
}

function renderMemory(entry: MemoryEntry): string {
  const useBadge = entry.useCount > 3 ? ` [used ${entry.useCount} times]` : '';
  const typeLabel = entry.type.charAt(0).toUpperCase() + entry.type.slice(1);
  return `### ${typeLabel} / ${entry.category}${useBadge}\n${entry.content.slice(0, 400)}`;
}
