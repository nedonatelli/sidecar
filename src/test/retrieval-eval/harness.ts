/**
 * Retrieval-eval harness (v0.62 e.1). Wires a `SymbolEmbeddingIndex`
 * + `SymbolGraph` populated from the synthetic fixture in
 * `fixture.ts`, so golden-case tests can ask "which symbols surface
 * for query X?" without touching real disk or a real ONNX model.
 *
 * The embedding pipeline is a deterministic fake that maps each
 * token's 3-char prefix to a hot slot — same shape as the fake in
 * `symbolEmbeddingIndex.test.ts`, but shared across eval cases so
 * every test scores the same query identically. Real-model semantics
 * are tested separately under `tests/llm-eval/` against a live
 * embedding backend.
 */

import { SymbolEmbeddingIndex, type SymbolSearchResult } from '../../config/symbolEmbeddingIndex.js';
import { SymbolGraph, type SymbolEntry, type CallEdge } from '../../config/symbolGraph.js';
import { MerkleTree } from '../../config/merkleTree.js';
import { enrichWithGraphWalk } from '../../agent/tools/projectKnowledge.js';
import { FIXTURE_FILES, type FixtureFile } from './fixture.js';

const DIMENSION = 384;

/**
 * Deterministic fake embedding pipeline. Tokenizes the input, maps
 * each token's first 3 characters to a slot via a stable word→slot
 * map (growing on demand), and returns a normalized unit vector. Two
 * inputs that share tokens light up overlapping slots → positive
 * cosine.
 *
 * The map is module-level so it's shared across every harness
 * instance in the same test run — that's what makes eval scoring
 * stable: query "auth" gets the same vector whether it runs first or
 * tenth.
 */
const wordToSlot = new Map<string, number>();
function slotFor(prefix: string): number {
  if (!wordToSlot.has(prefix)) {
    wordToSlot.set(prefix, wordToSlot.size % DIMENSION);
  }
  return wordToSlot.get(prefix)!;
}

function fakePipeline(texts: string[]): Promise<{ data: Float32Array }> {
  const vec = new Float32Array(DIMENSION);
  const input = texts[0].toLowerCase();
  const tokens = input.match(/[a-z]{2,}/g) ?? [];
  for (const token of tokens) {
    vec[slotFor(token.slice(0, 3))] = 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return Promise.resolve({ data: vec });
}

/**
 * What a golden case asks the harness to do + how to score the
 * result. See `goldenCases.ts` for the populated dataset.
 */
export interface GoldenCase {
  /** Human-readable label shown in the vitest report. */
  name: string;
  /** The natural-language query fed to the retriever. */
  query: string;
  /** Category tags — e.g. `'concept-search'`, `'graph-walk'`,
   *  `'path-filter'`, `'kind-filter'`. Used to bucket metrics later. */
  tags: string[];
  /**
   * Symbols that MUST appear in the top-K results. Each entry is a
   * `filePath::qualifiedName` ref so the harness can locate the
   * fixture symbol unambiguously. Non-empty for every case.
   */
  relevantSymbolIds: string[];
  /** Cap on top-K when scoring. Default 5 — tight enough that
   *  irrelevant hits bury the signal. */
  topK?: number;
  /** Optional kind filter forwarded into the search call. */
  kindFilter?: string[];
  /** Optional path prefix forwarded into the search call. */
  pathPrefix?: string;
  /**
   * How deep to walk the graph for the retriever-side enrichment.
   * Defaults to 1 (matching the production default on
   * `project_knowledge_search`). Set to 0 to score vector-only.
   */
  graphWalkDepth?: number;
  /** Budget on graph-reached additions; default 10. */
  maxGraphHits?: number;
}

/**
 * Shape of a single retrieval result fed into scorers. Unified
 * across vector + graph hits so scoring can be source-agnostic.
 */
export interface EvalHit {
  symbolId: string; // filePath::qualifiedName
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: string;
  rank: number;
  score: number;
  relationship: 'vector' | 'graph';
}

/**
 * Build a populated index + graph against the fixture. Returns the
 * two objects so tests can drive them independently — e.g. metric
 * evals at the vector level, walker evals at the graph level.
 *
 * The graph is hand-populated from the fixture's `calls` edges
 * rather than via tree-sitter parsing; this keeps the harness
 * independent of the parser and makes the golden dataset portable
 * to any language.
 */
export async function buildFixtureHarness(options: { withMerkle?: boolean } = {}): Promise<{
  index: SymbolEmbeddingIndex;
  graph: SymbolGraph;
  merkleTree: MerkleTree | null;
}> {
  const index = new SymbolEmbeddingIndex(null);
  index.setPipelineForTests(fakePipeline as never);
  const graph = new SymbolGraph();

  for (const file of FIXTURE_FILES) {
    seedFileIntoGraph(file, graph);
    await indexFileSymbols(file, index);
  }

  // v0.62 d.3: optionally wire a Merkle tree so the eval layer can
  // assert that descent-based query pruning doesn't regress
  // retrieval quality relative to the no-descent baseline.
  let merkleTree: MerkleTree | null = null;
  if (options.withMerkle) {
    merkleTree = new MerkleTree();
    index.setMerkleTree(merkleTree);
  }

  return { index, graph, merkleTree };
}

function seedFileIntoGraph(file: FixtureFile, graph: SymbolGraph): void {
  const symbols: SymbolEntry[] = file.symbols.map((s) => ({
    name: s.name,
    qualifiedName: s.qualifiedName,
    type: s.kind as SymbolEntry['type'],
    filePath: file.path,
    startLine: s.startLine,
    endLine: s.endLine,
    exported: s.exported,
  }));
  const callEdges: CallEdge[] = file.calls.map((c) => ({
    callerFile: file.path,
    callerName: c.callerQualifiedName,
    calleeName: c.calleeQualifiedName,
    line: c.line,
  }));
  // `addFile` handles both symbols and edges in one call.
  graph.addFile(file.path, symbols, [], `hash-${file.path}`, callEdges);
}

async function indexFileSymbols(file: FixtureFile, index: SymbolEmbeddingIndex): Promise<void> {
  const lines = file.source.split('\n');
  for (const sym of file.symbols) {
    const body = lines.slice(sym.startLine - 1, sym.endLine).join('\n');
    await index.indexSymbol({
      filePath: file.path,
      qualifiedName: sym.qualifiedName,
      name: sym.name,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      body,
    });
  }
}

/**
 * Run a single golden case through the retrieval stack. Returns a
 * ranked list of hits (vector first, then graph-walk-reached — same
 * ordering the `project_knowledge_search` tool surfaces) so scorers
 * can work against a shape that matches production.
 */
export async function runGoldenQuery(
  query: string,
  options: Pick<GoldenCase, 'topK' | 'kindFilter' | 'pathPrefix' | 'graphWalkDepth' | 'maxGraphHits'>,
  harness: { index: SymbolEmbeddingIndex; graph: SymbolGraph },
): Promise<EvalHit[]> {
  const topK = options.topK ?? 5;
  const kindFilter = options.kindFilter && options.kindFilter.length > 0 ? options.kindFilter : undefined;
  const pathPrefix = options.pathPrefix;
  const graphWalkDepth = options.graphWalkDepth ?? 1;
  const maxGraphHits = options.maxGraphHits ?? 10;

  const directHits = await harness.index.search(query, topK, { kindFilter, pathPrefix });
  // `enrichWithGraphWalk` is the same helper `project_knowledge_search`
  // uses in production — reusing it means the eval scores against the
  // real retrieval path, not a parallel implementation.
  const enriched = enrichWithGraphWalk(directHits, harness.graph, {
    maxDepth: graphWalkDepth,
    maxGraphHits,
  });

  return enriched.map((hit, rank) => ({
    symbolId: `${hit.filePath}::${hit.qualifiedName}`,
    filePath: hit.filePath,
    qualifiedName: hit.qualifiedName,
    name: hit.name,
    kind: hit.kind,
    rank,
    score: hit.score,
    relationship: hit.relationship.startsWith('graph') ? ('graph' as const) : ('vector' as const),
  }));
}

/**
 * Simple hit-rate scorer for the MVP. Returns `{ hit: true }` iff
 * every `relevantSymbolIds` entry appears somewhere in the result
 * list. Formal metrics (precision, recall, MRR) land in e.2.
 *
 * Exported so golden-case tests can invoke it directly without
 * going through the eval runner — useful for debugging a single
 * case in isolation.
 */
export function scoreAllRelevantPresent(
  hits: EvalHit[],
  relevantSymbolIds: string[],
): { hit: boolean; missing: string[]; foundAtRanks: number[] } {
  const seen = new Set(hits.map((h) => h.symbolId));
  const missing = relevantSymbolIds.filter((id) => !seen.has(id));
  const foundAtRanks = relevantSymbolIds
    .map((id) => hits.find((h) => h.symbolId === id))
    .filter((h): h is EvalHit => !!h)
    .map((h) => h.rank);
  return { hit: missing.length === 0, missing, foundAtRanks };
}

/**
 * Reusable search-result wrapper so scorers that want the
 * `SymbolSearchResult` shape (e.g. reciprocal-rank utilities) can
 * drop straight in.
 */
export function hitsToSearchResults(hits: EvalHit[]): SymbolSearchResult[] {
  return hits.map((h) => ({
    symbolId: h.symbolId,
    filePath: h.filePath,
    qualifiedName: h.qualifiedName,
    name: h.name,
    kind: h.kind,
    startLine: 0,
    endLine: 0,
    similarity: h.score,
  }));
}
