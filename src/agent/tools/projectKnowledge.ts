import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool } from './shared.js';
import { getDefaultToolRuntime } from './runtime.js';
import { enrichWithGraphWalk } from '../retrieval/graphExpansion.js';

// Re-export so existing tests + callers importing `enrichWithGraphWalk`
// from this tool module keep working. The implementation moved to
// `src/agent/retrieval/graphExpansion.ts` (v0.65 chunk 5.5) so the
// base SemanticRetriever can share the same walk logic.
export { enrichWithGraphWalk };

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

export const projectKnowledgeTools: RegisteredTool[] = [
  { definition: projectKnowledgeSearchDef, executor: projectKnowledgeSearch, requiresApproval: false },
];
