/**
 * Semantic index for SIDECAR.md sections.
 *
 * v0.92 SIDECAR.md retrieval mode: rather than injecting every section
 * (or every path-scoped section) on every turn, this index embeds each H2
 * section body with all-MiniLM-L6-v2 and scores sections against the
 * current query at run time. Only the top-K most relevant sections surface
 * in the system prompt — the same retrieval model used by the Project
 * Knowledge Index and EpisodicMemoryStore.
 *
 * Update strategy: incremental. `update(content)` hashes each parsed
 * section body and re-embeds only sections whose content changed since the
 * last call. Sections that disappear from the document are pruned from the
 * store. This keeps the embedding cost bounded even when the agent loop
 * calls `update()` on every turn.
 *
 * Persistence: the FlatVectorStore is persisted to
 * `.sidecar/cache/sidecarMd/` so embeddings survive VS Code restarts.
 * Version-mismatch or model-swap invalidation is handled by FlatVectorStore
 * itself (it clears stale caches and rebuilds on next `update()` call).
 */

import { parseSidecarMd } from './sidecarMdParser.js';
import { FlatVectorStore } from '../config/vectorStore.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { RetrievalHit } from './retrieval/retriever.js';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSION = 384;
const SCHEMA_VERSION = 1;
const MAX_SECTION_CHARS = 6000;

type EmbeddingPipeline = (
  texts: string[],
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

interface SectionMeta {
  heading: string;
  bodyHash: string;
  body: string;
}

function sectionId(heading: string): string {
  return `sidecarmd:${heading.toLowerCase().replace(/\s+/g, '-')}`;
}

/** djb2-style hash — fast, non-cryptographic, good enough for change detection. */
function quickHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export class SidecarMdIndex {
  private readonly store: FlatVectorStore<SectionMeta>;
  private pipeline: EmbeddingPipeline | null = null;
  private modelLoading: Promise<boolean> | null = null;

  constructor(sidecarDir: SidecarDir | null) {
    this.store = new FlatVectorStore<SectionMeta>(sidecarDir, {
      dimension: DIMENSION,
      version: SCHEMA_VERSION,
      binFile: 'cache/sidecarMd/vectors.bin',
      metaFile: 'cache/sidecarMd/meta.json',
    });
  }

  /**
   * Parse `content` and incrementally update the index:
   *   - re-embed sections whose body changed
   *   - prune sections that no longer exist in the document
   * No-ops silently when the embedding model fails to load.
   */
  async update(content: string): Promise<void> {
    if (!(await this.ensureModel())) return;

    const parsed = parseSidecarMd(content);
    const currentIds = new Set<string>();

    for (const section of parsed.sections) {
      const id = sectionId(section.heading);
      currentIds.add(id);
      const hash = quickHash(section.body);

      const existing = this.store.getMetadata(id);
      if (existing?.bodyHash === hash) continue; // unchanged — skip re-embed

      const truncated = section.body.slice(0, MAX_SECTION_CHARS);
      const vec = await this.embed(truncated);
      if (!vec) continue;
      await this.store.upsert({
        id,
        vector: vec,
        metadata: { heading: section.heading, bodyHash: hash, body: truncated },
      });
    }

    // Prune sections that were removed from the document
    await this.store.removeWhere((meta) => !currentIds.has(sectionId(meta.heading)));
    await this.store.persist();
  }

  /**
   * Return the top-`k` sections most semantically similar to `query`,
   * filtered to those above `minScore`. Returns [] when the index is
   * empty or embedding fails.
   */
  async search(query: string, k: number, minScore: number): Promise<RetrievalHit[]> {
    if (this.store.size() === 0) return [];
    const vec = await this.embed(query);
    if (!vec) return [];
    const hits = await this.store.search(vec, k);
    return hits
      .filter((h) => h.similarity >= minScore)
      .map((h) => ({
        id: h.id,
        score: h.similarity,
        source: 'sidecarMd',
        title: `SIDECAR.md · §${h.metadata.heading}`,
        content: `[SIDECAR.md · §${h.metadata.heading}]\n\n${h.metadata.body}`,
      }));
  }

  size(): number {
    return this.store.size();
  }

  async restore(): Promise<void> {
    await this.store.restore();
  }

  private async embed(text: string): Promise<Float32Array | null> {
    if (!(await this.ensureModel()) || !this.pipeline) return null;
    try {
      const output = await this.pipeline([text], { pooling: 'mean', normalize: true });
      return new Float32Array(output.data.slice(0, DIMENSION));
    } catch {
      return null;
    }
  }

  private async ensureModel(): Promise<boolean> {
    if (this.pipeline) return true;
    if (this.modelLoading) return this.modelLoading;
    this.modelLoading = (async () => {
      try {
        const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
        env.allowLocalModels = false;
        this.pipeline = (await createPipeline('feature-extraction', MODEL_ID, {
          dtype: 'q8',
        })) as unknown as EmbeddingPipeline;
        return true;
      } catch (err) {
        console.warn('[SidecarMdIndex] Embedding model failed to load:', err instanceof Error ? err.message : err);
        return false;
      }
    })();
    return this.modelLoading;
  }

  /** Test-only: inject a pre-built pipeline (or null to simulate load failure). */
  setPipelineForTests(pipeline: EmbeddingPipeline | null): void {
    this.pipeline = pipeline;
    this.modelLoading = Promise.resolve(pipeline !== null);
  }
}
