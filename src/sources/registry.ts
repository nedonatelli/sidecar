/**
 * SourceRegistry (v0.75).
 *
 * Process-wide singleton that maps URIs to the `Source` implementation that
 * can handle them. Concrete sources (PdfSource, ZoteroSource, …) register
 * themselves at extension activation; callers use `findFor(uri)` to get the
 * right source without coupling to concrete types.
 */

import type { Source, SourceDocument } from './types.js';

const sources: Source[] = [];

/**
 * Register a source. Later registrations take priority over earlier ones
 * when both claim to handle the same URI (first-match-wins after reverse).
 * Returns a teardown function that removes the source.
 */
export function registerSource(source: Source): () => void {
  sources.push(source);
  return () => {
    const idx = sources.indexOf(source);
    if (idx !== -1) sources.splice(idx, 1);
  };
}

/**
 * Find the most-recently-registered source that can handle `uri`.
 * Returns `undefined` when no source matches.
 */
export function findSourceFor(uri: string): Source | undefined {
  for (let i = sources.length - 1; i >= 0; i--) {
    if (sources[i].canHandle(uri)) return sources[i];
  }
  return undefined;
}

/**
 * Extract all chunks from `uri` using the first matching source.
 * Throws when no source can handle the URI.
 */
export async function* extractFromUri(uri: string, signal?: AbortSignal): AsyncGenerator<SourceDocument> {
  const source = findSourceFor(uri);
  if (!source) throw new Error(`No source registered for URI: ${uri}`);
  yield* source.extract(uri, signal);
}

/** All currently registered sources — for diagnostics. */
export function listSources(): readonly Source[] {
  return sources.slice();
}

/** Remove all registered sources — used in tests. */
export function clearSources(): void {
  sources.splice(0);
}
