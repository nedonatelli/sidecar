/**
 * Unified retrieval interface. Adapters for documentation search, agent
 * memory, and (future) semantic workspace search expose hit lists in a
 * common shape so reciprocal-rank fusion can rank across sources.
 */
export interface RetrievalHit {
  /** Stable id, typically `source:path:line` or `source:entryId`. */
  id: string;
  /** Native scorer score (unnormalized). Used only for per-source ordering. */
  score: number;
  /** Rendered markdown snippet the model will see if this hit is selected. */
  content: string;
  /** Which retriever produced this hit. */
  source: string;
  /** Optional provenance for rendering / dedup. */
  title?: string;
  filePath?: string;
}

export interface Retriever {
  /** Short name matching the `source` field on emitted hits. */
  name: string;
  /** Whether the retriever is currently usable (indexed, enabled). */
  isReady(): boolean;
  /** Return up to `k` hits for `query`, ordered by the retriever's native score. */
  retrieve(query: string, k: number): Promise<RetrievalHit[]>;
}
