import type { ToolDefinition } from '../../ollama/types.js';
import type { SymbolGraph } from '../../config/symbolGraph.js';
import type { SymbolSearchResult } from '../../config/symbolEmbeddingIndex.js';
import { getDefaultToolRuntime } from './runtime.js';

/**
 * `project_knowledge_search` — semantic search over every symbol
 * (function / class / method / interface / type) in the workspace,
 * backed by the `SymbolEmbeddingIndex` wired in v0.61 b.2. Returns
 * the specific symbol that matches, not the whole file, so follow-up
 * reads can jump straight to the relevant line range.
 *
 * The tool surfaces a structured response (one line per hit) that
 * the model can parse back into call-site jumps — `filePath:start-end`
 * is the exact grammar `read_file` + line-slicing already understand.
 *
 * v0.61 b.4: results can be enriched by walking the symbol graph's
 * `calls` edges up to `graphWalkDepth` hops, so a query like "where
 * is auth handled?" surfaces both `requireAuth` (direct vector hit)
 * AND every route handler that wraps it (reached via `getCallers`).
 * Each reached symbol is tagged with its relationship + hop count so
 * the model sees *why* it surfaced.
 */

/**
 * Unified result shape covering both direct vector hits and graph-
 * walk-reached symbols. Kept in this module (not the primitive) so
 * the walk logic stays colocated with the tool that renders it.
 */
interface EnrichedHit {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** Final ranking score — direct vector score or a decayed version
   *  for graph-walk-reached hits. */
  score: number;
  /** Human-readable provenance: `"vector: 0.823"` for direct hits,
   *  `"graph: called-by (1 hop from requireAuth)"` for reached
   *  symbols. Surfaced verbatim in the tool's rendered response. */
  relationship: string;
}

export const projectKnowledgeSearchDef: ToolDefinition = {
  name: 'project_knowledge_search',
  description:
    'Semantic search over symbols (functions / classes / methods / interfaces / types) in the workspace. ' +
    'Use when the user asks about a concept or capability by name ("where is auth handled?", "how do we compute similarity?") — returns the specific function/class, not the whole file. ' +
    'Not for literal string matches (use `grep`) or exact filename lookups (use `search_files`). Not for navigating a single file (use `read_file`). ' +
    'Requires `sidecar.projectKnowledge.enabled` — returns a short "not available" message when disabled or while the index is still warming up. ' +
    'Filters: `kindFilter` narrows to specific symbol kinds (e.g. `["function", "class"]`); `pathPrefix` restricts to a subdirectory (e.g. `"src/middleware/"`). ' +
    'Example: `project_knowledge_search(query="where auth tokens are validated", maxHits=5)`.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language query describing what you are looking for.',
      },
      maxHits: {
        type: 'number',
        description: 'Max number of results to return. Default: 10.',
      },
      kindFilter: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of symbol kinds to include, e.g. ["function", "class", "method", "interface", "type"].',
      },
      pathPrefix: {
        type: 'string',
        description: 'Optional path prefix to restrict results (e.g. "src/middleware/").',
      },
      graphWalkDepth: {
        type: 'number',
        description:
          'How many "calls" edges to walk from each direct vector hit, up to 3. Default: 1. Set to 0 to disable graph enrichment and return only vector matches.',
      },
      maxGraphHits: {
        type: 'number',
        description: 'Cap on symbols added via graph walk (across all starting hits). Default: 10, max: 50.',
      },
    },
    required: ['query'],
  },
};

/**
 * Walk the symbol graph's `calls` edges outward from each direct
 * vector hit, surfacing symbols whose text wouldn't have scored but
 * whose structural relationship to a scored symbol is load-bearing
 * (the canonical example: a route handler that wraps `requireAuth`
 * without mentioning "auth" in its own body).
 *
 * Extracted as a pure helper so tests can drive it against a hand-
 * constructed `SymbolGraph` fixture without having to spin up the
 * embedding pipeline.
 *
 * Budget semantics:
 *   - `maxDepth` caps hop distance per BFS frontier (0 disables).
 *   - `maxGraphHits` caps total symbols added across all starts.
 *   - Scores decay as `directScore * 0.5^hops` so a closely-related
 *     symbol ranks above a distantly-related one.
 */
export function enrichWithGraphWalk(
  directHits: SymbolSearchResult[],
  graph: SymbolGraph | null,
  options: { maxDepth: number; maxGraphHits: number },
): EnrichedHit[] {
  const { maxDepth, maxGraphHits } = options;

  const enriched: EnrichedHit[] = directHits.map((h) => ({
    filePath: h.filePath,
    qualifiedName: h.qualifiedName,
    name: h.name,
    kind: h.kind,
    startLine: h.startLine,
    endLine: h.endLine,
    score: h.similarity,
    relationship: `vector: ${h.similarity.toFixed(3)}`,
  }));

  if (!graph || maxDepth <= 0 || maxGraphHits <= 0) {
    enriched.sort((a, b) => b.score - a.score);
    return enriched;
  }

  // Track every symbol already surfaced so graph walks can't
  // double-add a symbol that's already a direct hit or was reached
  // via another start's BFS.
  const seen = new Set(enriched.map((e) => `${e.filePath}::${e.qualifiedName}`));
  let budget = maxGraphHits;

  for (const start of directHits) {
    if (budget <= 0) break;
    // BFS per starting hit so each walk is independent and we can
    // stop early when the global budget runs out.
    type Frontier = { symbolName: string; hops: number };
    const queue: Frontier[] = [{ symbolName: start.qualifiedName, hops: 0 }];
    while (queue.length > 0 && budget > 0) {
      const cur = queue.shift()!;
      if (cur.hops >= maxDepth) continue;
      const callers = graph.getCallers(cur.symbolName);
      for (const call of callers) {
        if (budget <= 0) break;
        // Resolve the caller site to its *containing* symbol (the
        // function whose body issues the call) — reporting a raw
        // line number is less actionable than pointing at the
        // enclosing function.
        const containing = graph
          .getSymbolsInFile(call.callerFile)
          .find((s) => s.startLine <= call.line && call.line <= s.endLine);
        if (!containing) continue;
        const id = `${call.callerFile}::${containing.qualifiedName}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const hopsFromStart = cur.hops + 1;
        enriched.push({
          filePath: call.callerFile,
          qualifiedName: containing.qualifiedName,
          name: containing.name,
          kind: containing.type,
          startLine: containing.startLine,
          endLine: containing.endLine,
          // Decayed score so direct hits stay above graph hops; the
          // 0.5 factor is borrowed from RRF-style dampening and is
          // conservative enough that a 2-hop symbol won't bury an
          // unrelated direct vector match.
          score: start.similarity * Math.pow(0.5, hopsFromStart),
          relationship: `graph: called-by (${hopsFromStart} hop${hopsFromStart === 1 ? '' : 's'} from ${start.name})`,
        });
        budget -= 1;
        if (hopsFromStart < maxDepth) {
          queue.push({ symbolName: containing.qualifiedName, hops: hopsFromStart });
        }
      }
    }
  }

  enriched.sort((a, b) => b.score - a.score);
  return enriched;
}

export async function projectKnowledgeSearch(input: Record<string, unknown>): Promise<string> {
  const query = (input.query as string | undefined)?.trim();
  if (!query) return 'Error: query is required.';

  const runtime = getDefaultToolRuntime();
  const index = runtime.symbolEmbeddings;
  if (!index) {
    return (
      'Project Knowledge Index is not enabled. Ask the user to set `sidecar.projectKnowledge.enabled: true` ' +
      'to use semantic symbol search, or fall back to `grep` / `search_files` for literal matching.'
    );
  }
  if (!index.isReady()) {
    return (
      'Project Knowledge Index is still warming up (embedding model loading or initial scan in progress). ' +
      'Fall back to `grep` / `search_files` for this query, or retry in a few seconds.'
    );
  }

  const maxHits = typeof input.maxHits === 'number' && input.maxHits > 0 ? Math.min(input.maxHits, 50) : 10;
  const kindFilter = Array.isArray(input.kindFilter)
    ? (input.kindFilter as unknown[]).filter((k): k is string => typeof k === 'string')
    : undefined;
  const pathPrefix = typeof input.pathPrefix === 'string' ? input.pathPrefix : undefined;
  // Graph-walk budgets — integer-valued, clamped to sane ranges. A
  // user that asks for negative depth gets 0 (disabled); an ask for
  // depth 50 gets 3.
  const graphWalkDepth =
    typeof input.graphWalkDepth === 'number' ? Math.max(0, Math.min(3, Math.floor(input.graphWalkDepth))) : 1;
  const maxGraphHits =
    typeof input.maxGraphHits === 'number' ? Math.max(0, Math.min(50, Math.floor(input.maxGraphHits))) : 10;

  const directHits = await index.search(query, maxHits, {
    kindFilter: kindFilter && kindFilter.length > 0 ? kindFilter : undefined,
    pathPrefix,
  });

  if (directHits.length === 0) {
    return (
      `No symbol-level matches for "${query}"` +
      (pathPrefix ? ` under ${pathPrefix}` : '') +
      '. The index may be empty (workspace still indexing) or no symbol is semantically similar — ' +
      'try a different phrasing or fall back to `grep`.'
    );
  }

  const enriched = enrichWithGraphWalk(directHits, runtime.symbolGraph, {
    maxDepth: graphWalkDepth,
    maxGraphHits,
  });

  const nDirect = directHits.length;
  const nGraph = enriched.length - nDirect;
  const header =
    nGraph > 0
      ? `Found ${nDirect} direct + ${nGraph} graph-reached symbol${enriched.length === 1 ? '' : 's'} for "${query}":`
      : `Found ${nDirect} symbol${nDirect === 1 ? '' : 's'} for "${query}":`;

  // One hit per line so the model can pattern-match against a known
  // shape. Relationship tag is the whole rightmost column so a
  // caller can split on tab and still get `filePath:range` first.
  const lines = enriched.map((r) => {
    const range = r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}-${r.endLine}`;
    return `${r.filePath}:${range}\t${r.kind}\t${r.qualifiedName}\t(${r.relationship})`;
  });
  return [header, '', ...lines].join('\n');
}
