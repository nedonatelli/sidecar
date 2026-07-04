/**
 * Session-scoped episodic memory for the agent loop.
 *
 * When the context compressor summarizes old turns, those summaries are
 * embedded and stored here. Before each LLM turn, the current user
 * message is used to query the store and the top-K hits (above a
 * similarity floor) are injected into the system prompt as a
 * `<prior_context>` block.
 *
 * This means the agent can "remember" relevant earlier decisions even
 * after they've been compressed out of the message window — without
 * re-expanding the context.
 *
 * The store is entirely in-memory and session-scoped: it is never
 * persisted and starts empty every time the loop initialises.
 */

import { FlatVectorStore } from '../config/vectorStore.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import { MINILM_MODEL_ID as MODEL_ID, type EmbeddingPipeline, LazyEmbedder } from '../config/hfPipeline.js';
const DIMENSION = 384;
/** Truncate input before embedding to avoid OOM on pathologically long summaries. */
const MAX_TEXT_CHARS = 8000;
/** Minimum cosine similarity for a hit to be included in the context block. */
export const MIN_EPISODIC_SIMILARITY = 0.4;
const DEFAULT_K = 3;

export interface EpisodicHit {
  summary: string;
  turnIndex: number;
  similarity: number;
}

interface EpisodicMeta {
  summary: string;
  turnIndex: number;
  addedAt: number;
}

export class EpisodicMemoryStore {
  private store: FlatVectorStore<EpisodicMeta>;
  private embedder = new LazyEmbedder({ label: 'EpisodicMemory', dimension: DIMENSION, maxChars: MAX_TEXT_CHARS });

  constructor(sidecarDir: SidecarDir | null = null) {
    this.store = new FlatVectorStore<EpisodicMeta>(sidecarDir, {
      dimension: DIMENSION,
      version: 1,
      binFile: 'cache/episodic/vectors.bin',
      metaFile: 'cache/episodic/meta.json',
      extraMeta: { modelId: MODEL_ID },
      validateMeta(meta) {
        return (
          meta.version === 1 && meta.dimension === DIMENSION && (meta as { modelId?: string }).modelId === MODEL_ID
        );
      },
    });
  }

  /** Flush the current store entries to disk. No-op when no sidecarDir. */
  async persist(): Promise<void> {
    await this.store.persist();
  }

  /** Restore store entries from disk. No-op when no sidecarDir or cache absent. */
  async restore(): Promise<void> {
    await this.store.restore();
  }

  isEmpty(): boolean {
    return this.store.size() === 0;
  }

  size(): number {
    return this.store.size();
  }

  /**
   * Embed `summary` and add it to the store keyed by `turnIndex`.
   * No-ops silently when the embedding model fails to load.
   */
  async add(summary: string, turnIndex: number): Promise<void> {
    const vec = await this.embed(summary);
    if (!vec) return;
    const id = `turn-${turnIndex}-${Date.now()}`;
    await this.store.upsert({ id, vector: vec, metadata: { summary, turnIndex, addedAt: Date.now() } });
  }

  /**
   * Return the top-K stored entries most similar to `text`, filtered
   * to those above `MIN_EPISODIC_SIMILARITY`. Returns [] when the
   * store is empty or embedding fails.
   */
  async query(text: string, k: number = DEFAULT_K): Promise<EpisodicHit[]> {
    if (this.isEmpty()) return [];
    const vec = await this.embed(text);
    if (!vec) return [];
    const hits = await this.store.search(vec, k);
    return hits
      .filter((h) => h.similarity >= MIN_EPISODIC_SIMILARITY)
      .map((h) => ({
        summary: h.metadata.summary,
        turnIndex: h.metadata.turnIndex,
        similarity: h.similarity,
      }));
  }

  /**
   * Build a `<prior_context>` block for injection into the system prompt.
   * Returns `undefined` when the store is empty or no hits clear the
   * similarity floor.
   */
  async buildContextBlock(queryText: string): Promise<string | undefined> {
    const hits = await this.query(queryText);
    if (hits.length === 0) return undefined;

    const lines = hits.map((h) => `- ${h.summary.replace(/\n+/g, ' ').trim().slice(0, 400)}`);
    return (
      `<prior_context>\n` +
      `Relevant context from earlier in this or previous sessions (retrieved by semantic similarity to current task):\n` +
      lines.join('\n') +
      `\n</prior_context>`
    );
  }

  private embed(text: string): Promise<Float32Array | null> {
    return this.embedder.embed(text);
  }

  /** Test-only: inject a pre-built pipeline (or null to simulate load failure). */
  setPipelineForTests(pipeline: EmbeddingPipeline | null): void {
    this.embedder.setPipelineForTests(pipeline);
  }
}
