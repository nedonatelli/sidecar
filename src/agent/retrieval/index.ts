import { Retriever, RetrievalHit } from './retriever';
import { reciprocalRankFusion } from './fusion';

export { Retriever, RetrievalHit } from './retriever';
export { reciprocalRankFusion } from './fusion';
export { DocRetriever } from './docRetriever';
export { MemoryRetriever } from './memoryRetriever';
export { SemanticRetriever } from './semanticRetriever';

/**
 * Run a set of retrievers in parallel and fuse their rankings with RRF.
 * Retrievers that are not ready are skipped silently. Returns up to
 * `topK` fused hits. Each retriever is queried for `perSourceK` items so
 * that a weaker retriever can still contribute lower-ranked items to the
 * fused list when the stronger retriever also has a match.
 */
export async function fuseRetrievers(
  retrievers: Retriever[],
  query: string,
  topK: number,
  perSourceK: number = topK,
): Promise<RetrievalHit[]> {
  const active = retrievers.filter((r) => r.isReady());
  if (active.length === 0) return [];
  const lists = await Promise.all(
    active.map(async (r) => {
      try {
        return await r.retrieve(query, perSourceK);
      } catch {
        return [] as RetrievalHit[];
      }
    }),
  );
  return reciprocalRankFusion(lists).slice(0, topK);
}

/**
 * Render fused hits as a single markdown section suitable for system-
 * prompt injection. Hits keep their source-authored content verbatim;
 * this wrapper just prepends a shared header and inserts a blank line
 * between hits so the model can see the boundaries.
 */
export function renderFusedContext(hits: RetrievalHit[], header = '## Retrieved Context'): string {
  if (hits.length === 0) return '';
  const body = hits.map((h) => h.content).join('\n\n');
  return `${header}\n\n${body}`;
}
