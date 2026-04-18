import type { SymbolGraph } from '../../config/symbolGraph.js';
import type { SymbolSearchResult } from '../../config/symbolEmbeddingIndex.js';

// ---------------------------------------------------------------------------
// Call-graph expansion for retrieval (v0.65 chunk 5.5).
//
// This module was extracted from `src/agent/tools/projectKnowledge.ts`
// so both the `project_knowledge_search` tool AND the base
// `SemanticRetriever` can share the same graph-walk logic. Previously
// only the tool invoked `enrichWithGraphWalk`, which meant every
// other retrieval call (system-prompt context assembly, fused RAG)
// returned raw vector hits with no dependency expansion — a known
// gap for densely-interconnected codebases where a relevant symbol
// wouldn't score on keywords but would show up as a direct caller
// of one that did.
//
// Now the retriever expands by default. Depth is adaptive
// (`adaptiveGraphDepth`) so small-context local models don't blow
// their token budget on speculative hops.
// ---------------------------------------------------------------------------

/**
 * Unified retrieval hit covering both direct vector matches and
 * symbols surfaced via call-graph walks. `relationship` is the
 * human-readable provenance string surfaced to the model so it sees
 * *why* a symbol appeared (e.g. `vector: 0.823` or
 * `graph: called-by (1 hop from requireAuth)`).
 */
export interface EnrichedHit {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** Final ranking score — direct vector score or `direct * 0.5^hops`. */
  score: number;
  /** Provenance label, rendered alongside the symbol body. */
  relationship: string;
}

export interface GraphWalkOptions {
  /** Cap per-BFS frontier hop distance. 0 disables the walk. */
  readonly maxDepth: number;
  /** Cap on total symbols added via walk (across all starts). */
  readonly maxGraphHits: number;
}

/**
 * Walk the symbol graph's `calls` edges outward from each direct
 * vector hit, surfacing symbols whose text wouldn't have scored but
 * whose structural relationship to a scored symbol is load-bearing.
 *
 * Canonical example: a route handler that wraps `requireAuth` without
 * mentioning "auth" in its own body. Vector retrieval misses it; a
 * 1-hop caller walk from the `requireAuth` direct hit surfaces it.
 *
 * Budget semantics:
 *   - `maxDepth` caps hop distance per BFS frontier (0 disables).
 *   - `maxGraphHits` caps total symbols added across all starts.
 *   - Scores decay as `directScore * 0.5^hops` so a closely-related
 *     symbol ranks above a distantly-related one.
 *
 * Extracted from `src/agent/tools/projectKnowledge.ts`. The tool
 * re-exports `enrichWithGraphWalk` for backward compatibility with
 * existing tests.
 */
export function enrichWithGraphWalk(
  directHits: SymbolSearchResult[],
  graph: SymbolGraph | null,
  options: GraphWalkOptions,
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

  const seen = new Set(enriched.map((e) => `${e.filePath}::${e.qualifiedName}`));
  let budget = maxGraphHits;

  for (const start of directHits) {
    if (budget <= 0) break;
    type Frontier = { symbolName: string; hops: number };
    const queue: Frontier[] = [{ symbolName: start.qualifiedName, hops: 0 }];
    while (queue.length > 0 && budget > 0) {
      const cur = queue.shift()!;
      if (cur.hops >= maxDepth) continue;
      const callers = graph.getCallers(cur.symbolName);
      for (const call of callers) {
        if (budget <= 0) break;
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

/**
 * Pick a reasonable graph-walk depth for the given model context size.
 *
 * Rationale: graph expansion is cheap in compute but expensive in
 * tokens (each surfaced symbol's body lands in the context window).
 * Small-context local models (Ollama 8K) can't absorb aggressive
 * expansion without evicting the user's actual question. Large-
 * context paid backends (Claude 200K) benefit from deeper walks
 * because the dependency cone is where the bugs are.
 *
 * Bands:
 *   - < 8K tokens       → depth 0 (no walk; bare vector retrieval)
 *   - 8K to < 64K       → depth 1 (one hop — broad value, bounded cost)
 *   - ≥ 64K             → depth 2 (two hops — paid backends absorb it)
 *
 * `null` / `undefined` contextLength → depth 1 (middle-ground default
 * when the backend doesn't advertise a context window). Negative or
 * zero values clamp to 0 since that indicates a misconfigured probe.
 */
export function adaptiveGraphDepth(contextLength: number | null | undefined): number {
  if (contextLength === null || contextLength === undefined) return 1;
  if (contextLength <= 0) return 0;
  if (contextLength < 8192) return 0;
  if (contextLength < 65536) return 1;
  return 2;
}
