import { Retriever, RetrievalHit } from './retriever';
import { logger } from '../../system/logger.js';
import { reciprocalRankFusion } from './fusion';
export { rewriteQuery } from './queryRewriter';
export type { QueryRewriteMode, CompleteFn } from './queryRewriter';

export { Retriever, RetrievalHit } from './retriever';
export { DocRetriever } from './docRetriever';
export { MemoryRetriever } from './memoryRetriever';
export { SemanticRetriever } from './semanticRetriever';
export { PdfRetriever } from './pdfRetriever';
export { ChunkRetriever } from './chunkRetriever';
export { SidecarMdRetriever } from './sidecarMdRetriever';
export { adaptiveGraphDepth, enrichWithGraphWalk } from './graphExpansion';
export type { EnrichedHit, GraphWalkOptions } from './graphExpansion';
export { applyZenFilter } from './zenFilter.js';

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
      } catch (err) {
        logger.warn(`[SideCar] Retriever "${r.name}" failed:`, err instanceof Error ? err.message : err);
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
export function renderFusedContext(
  hits: RetrievalHit[],
  header = '## Retrieved Context',
  mode: 'full' | 'reference' = 'full',
): string {
  if (hits.length === 0) return '';
  if (mode === 'full') {
    const body = hits.map((h) => h.content).join('\n\n');
    return `${header}\n\n${body}`;
  }
  // Reference mode — for agentic/editing tasks. A full file BODY frozen in the
  // system prompt goes stale the moment the agent edits that file (the system
  // prompt is built once per turn and reused for every loop iteration), which
  // anchors the model to outdated content and drives repeated full rewrites.
  // So workspace-code hits (those with a filePath) collapse to path references
  // the agent reads with read_file (always current). Non-code hits (docs,
  // memory — no filePath) keep their content; they aren't edited, so no staleness.
  const refsByPath = new Map<string, Set<string>>();
  const nonCode: string[] = [];
  for (const h of hits) {
    if (h.filePath) {
      const titles = refsByPath.get(h.filePath) ?? new Set<string>();
      if (h.title) titles.add(h.title);
      refsByPath.set(h.filePath, titles);
    } else {
      nonCode.push(h.content);
    }
  }
  const sections: string[] = [];
  if (refsByPath.size > 0) {
    const lines = [
      '## Relevant files (read with read_file for current contents — the agent edits these, so do not treat any cached snippet as current)',
    ];
    for (const [filePath, titles] of refsByPath) {
      lines.push(`- \`${filePath}\`${titles.size > 0 ? ` — ${[...titles].join(', ')}` : ''}`);
    }
    sections.push(lines.join('\n'));
  }
  if (nonCode.length > 0) {
    sections.push(`${header}\n\n${nonCode.join('\n\n')}`);
  }
  return sections.join('\n\n');
}
