import * as fs from 'fs';
import * as path from 'path';
import { getDefaultToolRuntime } from './runtime.js';
import type { SymbolGraph } from '../../config/symbolGraph.js';

// Shared preamble for the code-graph analysis tools (numerical contracts,
// property tests, shape consistency, code-graph query, impact). Each needs the
// same readiness gate and, for the source-reading tools, the same "prefer the
// graph's cached content, else read from disk" reader.

/** Standard "still indexing" message returned when the symbol graph isn't ready. */
export const SYMBOL_GRAPH_UNAVAILABLE = 'Symbol graph not available yet (workspace still indexing). Retry shortly.';

/** The active symbol graph, or null when the workspace is still indexing. */
export function requireSymbolGraph(): SymbolGraph | null {
  return getDefaultToolRuntime().symbolGraph;
}

/**
 * Build a source reader that prefers the graph's cached file content and falls
 * back to reading from disk (root-relative for relative paths).
 */
export function makeGraphSourceReader(graph: SymbolGraph, root: string): (f: string) => string | undefined {
  return (f) => {
    const cached = graph.getFileContent(f);
    if (cached) return cached;
    try {
      return fs.readFileSync(root && !path.isAbsolute(f) ? path.join(root, f) : f, 'utf-8');
    } catch {
      return undefined;
    }
  };
}
