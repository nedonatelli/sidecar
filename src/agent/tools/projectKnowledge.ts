import type { ToolDefinition } from '../../ollama/types.js';
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
 * Graph-walk enrichment lands in step b.4; the MVP here just returns
 * direct vector hits.
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

  const results = await index.search(query, maxHits, {
    kindFilter: kindFilter && kindFilter.length > 0 ? kindFilter : undefined,
    pathPrefix,
  });

  if (results.length === 0) {
    return (
      `No symbol-level matches for "${query}"` +
      (pathPrefix ? ` under ${pathPrefix}` : '') +
      '. The index may be empty (workspace still indexing) or no symbol is semantically similar — ' +
      'try a different phrasing or fall back to `grep`.'
    );
  }

  // One hit per line so the model can pattern-match against a known
  // shape. `score` rounds to 3 decimals to keep the rendering compact.
  const lines = results.map((r) => {
    const score = r.similarity.toFixed(3);
    const range = r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}-${r.endLine}`;
    return `${r.filePath}:${range}\t${r.kind}\t${r.qualifiedName}\t(vector: ${score})`;
  });
  return [`Found ${results.length} symbol${results.length === 1 ? '' : 's'} for "${query}":`, '', ...lines].join('\n');
}
