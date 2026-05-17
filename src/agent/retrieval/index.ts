import { Retriever, RetrievalHit } from './retriever';
import { reciprocalRankFusion } from './fusion';
export { rewriteQuery } from './queryRewriter';
export type { QueryRewriteMode, CompleteFn } from './queryRewriter';

export { Retriever, RetrievalHit } from './retriever';
export { reciprocalRankFusion } from './fusion';
export { DocRetriever } from './docRetriever';
export { MemoryRetriever } from './memoryRetriever';
export { SemanticRetriever } from './semanticRetriever';
export { PdfRetriever } from './pdfRetriever';
export { ChunkRetriever } from './chunkRetriever';
export { SidecarMdRetriever } from './sidecarMdRetriever';
export { adaptiveGraphDepth, enrichWithGraphWalk } from './graphExpansion';
export type { EnrichedHit, GraphWalkOptions } from './graphExpansion';

/**
 * Run retrieval for each query variant, then fuse all result lists with RRF.
 * For single-query callers this degenerates to a plain `fuseRetrievers` call.
 * For multi-query (expand mode) each variant can surface different hits and
 * RRF reconciles them into a single ranked list without double-counting.
 */
export async function fuseRetrieversMultiQuery(
  retrievers: Retriever[],
  queries: string[],
  topK: number,
  perSourceK: number = topK,
): Promise<RetrievalHit[]> {
  if (queries.length === 1) return fuseRetrievers(retrievers, queries[0], topK, perSourceK);
  const lists = await Promise.all(queries.map((q) => fuseRetrievers(retrievers, q, perSourceK, perSourceK)));
  return reciprocalRankFusion(lists).slice(0, topK);
}

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
