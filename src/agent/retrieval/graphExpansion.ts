import type { SymbolGraph } from '../../config/symbolGraph.js';
import type { SymbolSearchResult } from '../../config/symbolEmbeddingIndex.js';

// ---------------------------------------------------------------------------
// Call-graph expansion for retrieval.
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
  /**
   * Which directions to expand from each hit:
   *   - `callers` — functions that CALL the hit (upstream; who depends on it).
   *   - `callees` — what the hit CALLS (downstream; its own dependencies).
   * Default BOTH, so the auto-assembled context matches what a developer reads:
   * who calls this AND what it calls. Both share the same `maxGraphHits` budget
   * (interleaved so many callers can't starve callees), so bidirectional
   * expansion is a richer MIX at the same token cost, not more tokens. Callees
   * resolve via the graph's name→definition index and no-op on graphs that don't
   * expose it — preserving callers-only behavior for partial/legacy graphs.
   */
  readonly directions?: ReadonlyArray<'callers' | 'callees'>;
}

/** The subset of the symbol graph the walk needs. `getCallees`/`lookupSymbol`
 *  are optional so a partial graph (or an older test mock) degrades to
 *  callers-only rather than throwing. */
type WalkGraph = Pick<SymbolGraph, 'getCallers' | 'getSymbolsInFile'> & {
  getCallees?: SymbolGraph['getCallees'];
  lookupSymbol?: SymbolGraph['lookupSymbol'];
};

interface Neighbor {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  direction: 'callers' | 'callees';
}

/** Resolve a symbol's graph neighbors in the requested directions. Callers come
 *  from `getCallers` (resolved to the containing symbol at the call site);
 *  callees from `getCallees` (resolved to the callee's DEFINITION via
 *  `lookupSymbol`). Interleaved callee-first so a symbol with many callers can't
 *  crowd its callees out of a shared budget. */
function graphNeighbors(
  graph: WalkGraph,
  symbolName: string,
  directions: ReadonlyArray<'callers' | 'callees'>,
): Neighbor[] {
  const callers: Neighbor[] = [];
  const callees: Neighbor[] = [];

  if (directions.includes('callers')) {
    for (const call of graph.getCallers(symbolName)) {
      const containing = graph
        .getSymbolsInFile(call.callerFile)
        .find((s) => s.startLine <= call.line && call.line <= s.endLine);
      if (containing) {
        callers.push({
          filePath: call.callerFile,
          qualifiedName: containing.qualifiedName,
          name: containing.name,
          kind: containing.type,
          startLine: containing.startLine,
          endLine: containing.endLine,
          direction: 'callers',
        });
      }
    }
  }

  if (directions.includes('callees') && graph.getCallees && graph.lookupSymbol) {
    for (const call of graph.getCallees(symbolName)) {
      const def = graph.lookupSymbol(call.calleeName)[0];
      if (def) {
        callees.push({
          filePath: def.filePath,
          qualifiedName: def.qualifiedName,
          name: def.name,
          kind: def.type,
          startLine: def.startLine,
          endLine: def.endLine,
          direction: 'callees',
        });
      }
    }
  }

  const out: Neighbor[] = [];
  const max = Math.max(callers.length, callees.length);
  for (let i = 0; i < max; i++) {
    if (i < callees.length) out.push(callees[i]);
    if (i < callers.length) out.push(callers[i]);
  }
  return out;
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
  const directions = options.directions ?? ['callers', 'callees'];

  for (const start of directHits) {
    if (budget <= 0) break;
    type Frontier = { symbolName: string; hops: number };
    const queue: Frontier[] = [{ symbolName: start.qualifiedName, hops: 0 }];
    let head = 0;
    while (head < queue.length && budget > 0) {
      const cur = queue[head++];
      if (cur.hops >= maxDepth) continue;
      for (const n of graphNeighbors(graph, cur.symbolName, directions)) {
        if (budget <= 0) break;
        const id = `${n.filePath}::${n.qualifiedName}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const hopsFromStart = cur.hops + 1;
        const rel = n.direction === 'callers' ? 'called-by' : 'calls';
        enriched.push({
          filePath: n.filePath,
          qualifiedName: n.qualifiedName,
          name: n.name,
          kind: n.kind,
          startLine: n.startLine,
          endLine: n.endLine,
          score: start.similarity * Math.pow(0.5, hopsFromStart),
          relationship: `graph: ${rel} (${hopsFromStart} hop${hopsFromStart === 1 ? '' : 's'} from ${start.name})`,
        });
        budget -= 1;
        if (hopsFromStart < maxDepth) {
          queue.push({ symbolName: n.qualifiedName, hops: hopsFromStart });
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
