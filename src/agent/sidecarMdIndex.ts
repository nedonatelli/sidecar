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
import { type EmbeddingPipeline, LazyEmbedder } from '../config/hfPipeline.js';
const DIMENSION = 384;
const SCHEMA_VERSION = 1;
const MAX_SECTION_CHARS = 6000;

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
  private embedder = new LazyEmbedder({ label: 'SidecarMdIndex', dimension: DIMENSION });

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
    if (!(await this.embedder.ensureReady())) return;

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
    const vec = await this.embed(query, { priority: true });
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

  private embed(text: string, opts?: { priority?: boolean }): Promise<Float32Array | null> {
    return this.embedder.embed(text, opts);
  }

  /** Test-only: inject a pre-built pipeline (or null to simulate load failure). */
  setPipelineForTests(pipeline: EmbeddingPipeline | null): void {
    this.embedder.setPipelineForTests(pipeline);
  }
}
