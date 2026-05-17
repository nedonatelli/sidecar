import type { Retriever, RetrievalHit } from './retriever.js';
import type { SidecarMdIndex } from '../sidecarMdIndex.js';

/**
 * Retriever that scores SIDECAR.md sections against the current query using
 * the semantic index built by `SidecarMdIndex`. Plugs into the RRF fusion
 * pipeline alongside DocRetriever, SemanticRetriever, etc.
 *
 * Active only when `sidecar.sidecarMd.mode` is `'retrieval'`. When the
 * index is empty (embedding model loading, cold start, or no SIDECAR.md),
 * `isReady()` returns false and the fusion pipeline skips it silently.
 */
export class SidecarMdRetriever implements Retriever {
  readonly name = 'sidecarMd';

  constructor(
    private readonly index: SidecarMdIndex,
    private readonly topK: number,
    private readonly minScore: number,
  ) {}

  isReady(): boolean {
    return this.index.size() > 0;
  }

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    return this.index.search(query, Math.min(k, this.topK), this.minScore);
  }
}
