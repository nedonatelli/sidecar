/**
 * Backend abstraction for the Project Knowledge Index's vector
 * storage (v0.62 c.2). Pure-TS interface + a flat in-memory
 * implementation that matches the v0.61 behavior exactly. Designed
 * so a future release can drop in a LanceDB-backed implementation
 * without changing `SymbolEmbeddingIndex`.
 *
 * Why abstract now instead of when Lance lands? Getting the seam
 * right without a second implementation to validate it is a
 * guessing game — but the shape here is deliberately small (upsert,
 * remove, similarity search, persistence) so there's no obvious
 * place for the interface to be wrong. Lance's own Rust API is
 * roughly this same shape, so the adapter should be thin.
 *
 * Not a public API — consumers always go through `SymbolEmbeddingIndex`.
 * Exposed from this module so tests can hand-build fixtures against
 * the interface without going through the full embedding pipeline.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SidecarDir } from './sidecarDir.js';

/** A single stored vector with associated domain metadata. */
export interface VectorRecord<M> {
  id: string;
  vector: Float32Array;
  metadata: M;
}

/** One result from a similarity search. */
export interface VectorSearchHit<M> {
  id: string;
  metadata: M;
  similarity: number;
}

/**
 * Contract every PKI vector backend must fulfill. Deliberately
 * small — anything domain-specific (body-hash short-circuit, symbol
 * chunking, kind-filter semantics) stays in `SymbolEmbeddingIndex`
 * above this layer.
 */
export interface VectorStore<M> {
  /** Add or replace a record by id. Idempotent — the caller already
   *  decided (e.g. via content-hash) that a re-upsert is needed. */
  upsert(record: VectorRecord<M>): Promise<void>;
  /** Remove a record by id. Returns true iff the id existed. */
  remove(id: string): Promise<boolean>;
  /** Remove every record whose metadata matches `predicate`. Returns
   *  the number of records actually dropped. Lance implements this
   *  via a native WHERE clause; the flat impl filters in memory. */
  removeWhere(predicate: (metadata: M) => boolean): Promise<number>;
  /**
   * Cosine-similarity search over stored vectors, optionally filtered
   * by metadata. Returns up to `k` hits sorted descending by similarity.
   * The filter runs *before* scoring in the Lance impl and after in
   * the flat impl — same results, different cost.
   */
  search(query: Float32Array, k: number, filter?: (metadata: M) => boolean): Promise<VectorSearchHit<M>[]>;
  /** Total record count. */
  size(): number;
  /** Look up one record's metadata without reading its vector. */
  getMetadata(id: string): M | null;
  /** Iterate every (id, metadata) pair. Order is implementation-defined. */
  entries(): Iterable<{ id: string; metadata: M }>;
  /** Write current state to durable storage. Implementation-specific
   *  file format; `SymbolEmbeddingIndex` doesn't need to know. */
  persist(): Promise<void>;
  /** Restore state from durable storage. No-op if nothing is stored. */
  restore(): Promise<void>;
  /** Drop the persisted state from disk without touching the in-memory
   *  store. Used when the metadata schema changes in a backwards-
   *  incompatible way and the caller wants a clean rebuild. */
  clearPersisted(): Promise<void>;
}

/**
 * Serializable envelope format used by `FlatVectorStore.persist` /
 * `restore`. The schema matches the v0.61 SymbolEmbeddingIndex
 * on-disk layout exactly so upgrades don't invalidate existing caches.
 */
export interface FlatStoreMeta<M> {
  version: number;
  dimension: number;
  count: number;
  /** One entry per stored record, keyed by id. `offset` is the row
   *  index into the packed vector file (byte offset = offset × dim × 4). */
  entries: Record<string, M & { offset: number }>;
}

/**
 * Configuration FlatVectorStore needs to persist — binary file path
 * + metadata file path, both relative to `.sidecar/`. Passing these
 * in lets a single backend class serve multiple stores (e.g. the
 * symbol index vs. a later Merkle-interior-node index) without
 * hardcoding filenames.
 */
export interface FlatVectorStoreConfig {
  dimension: number;
  /** Schema version; incrementing invalidates older persisted caches. */
  version: number;
  /** Sidecar-relative paths. `binFile` stores the packed vector bytes;
   *  `metaFile` stores JSON metadata + id→offset mapping. */
  binFile: string;
  metaFile: string;
  /**
   * Extra top-level fields persisted alongside the envelope — e.g.
   * the caller's `modelId` for the symbol-embedding store. These are
   * written into the JSON file on persist and passed into
   * `validateMeta` on restore so the caller can reject incompatible
   * caches (model swap, schema drift) without hardcoding the
   * knowledge here. Preserves bit-for-bit compatibility with the
   * pre-abstraction v0.61 on-disk format.
   */
  extraMeta?: Record<string, unknown>;
  /** Optional sanity check — `true` iff the persisted meta envelope
   *  is valid for this store (model id match, dimension match, etc.).
   *  Default: version-and-dimension match. */
  validateMeta?(meta: FlatStoreMeta<unknown> & Record<string, unknown>): boolean;
}

/**
 * In-memory vector store with flat Float32Array backing + file
 * persistence (v0.62 c.2). Behavior-identical to the v0.61
 * SymbolEmbeddingIndex internal storage — the extraction is purely
 * to let a later Lance backend plug in without SymbolEmbeddingIndex
 * noticing.
 */
export class FlatVectorStore<M> implements VectorStore<M> {
  private dimension: number;
  private version: number;
  private binFile: string;
  private metaFile: string;
  private extraMeta: Record<string, unknown>;
  private validateMeta: (meta: FlatStoreMeta<unknown> & Record<string, unknown>) => boolean;
  private sidecarDir: SidecarDir | null;

  /** Packed row-major vector storage. Length = count × dimension. */
  private vectors = new Float32Array(0);
  /** id → { metadata, offset } lookup. */
  private entriesById = new Map<string, { metadata: M; offset: number }>();

  constructor(sidecarDir: SidecarDir | null, config: FlatVectorStoreConfig) {
    this.sidecarDir = sidecarDir;
    this.dimension = config.dimension;
    this.version = config.version;
    this.binFile = config.binFile;
    this.metaFile = config.metaFile;
    this.extraMeta = config.extraMeta ?? {};
    this.validateMeta =
      config.validateMeta ?? ((meta) => meta.version === this.version && meta.dimension === this.dimension);
  }

  async upsert(record: VectorRecord<M>): Promise<void> {
    if (record.vector.length !== this.dimension) {
      throw new Error(
        `FlatVectorStore.upsert: vector length ${record.vector.length} does not match expected dimension ${this.dimension}`,
      );
    }
    const existing = this.entriesById.get(record.id);
    if (existing) {
      // Overwrite in place so we don't grow the vector array on
      // every re-embed of the same symbol. Metadata may have
      // changed (e.g. line range shifted after an edit above).
      this.vectors.set(record.vector, existing.offset * this.dimension);
      this.entriesById.set(record.id, { metadata: record.metadata, offset: existing.offset });
      return;
    }
    // New record — extend the packed vector array.
    const offset = this.entriesById.size;
    const grown = new Float32Array((offset + 1) * this.dimension);
    grown.set(this.vectors);
    grown.set(record.vector, offset * this.dimension);
    this.vectors = grown;
    this.entriesById.set(record.id, { metadata: record.metadata, offset });
  }

  async remove(id: string): Promise<boolean> {
    // Mark-only delete — the vector row stays allocated and becomes
    // an orphan. A subsequent persist rewrites the file compactly
    // (since we only persist live entries), so the gap is transient.
    // This matches v0.61 SymbolEmbeddingIndex semantics.
    return this.entriesById.delete(id);
  }

  async removeWhere(predicate: (metadata: M) => boolean): Promise<number> {
    let removed = 0;
    for (const [id, entry] of this.entriesById.entries()) {
      if (predicate(entry.metadata)) {
        this.entriesById.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async search(query: Float32Array, k: number, filter?: (metadata: M) => boolean): Promise<VectorSearchHit<M>[]> {
    if (query.length !== this.dimension || this.entriesById.size === 0) return [];

    const hits: VectorSearchHit<M>[] = [];
    for (const [id, entry] of this.entriesById.entries()) {
      if (filter && !filter(entry.metadata)) continue;
      const start = entry.offset * this.dimension;
      const vec = this.vectors.subarray(start, start + this.dimension);
      hits.push({ id, metadata: entry.metadata, similarity: cosine(query, vec) });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, k);
  }

  size(): number {
    return this.entriesById.size;
  }

  getMetadata(id: string): M | null {
    return this.entriesById.get(id)?.metadata ?? null;
  }

  *entries(): Iterable<{ id: string; metadata: M }> {
    for (const [id, entry] of this.entriesById.entries()) {
      yield { id, metadata: entry.metadata };
    }
  }

  async persist(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;

    // Build compact persisted view — only live entries, re-offset
    // sequentially so the orphan rows from removes don't waste disk.
    const persistedEntries: Record<string, M & { offset: number }> = {};
    const liveVectors = new Float32Array(this.entriesById.size * this.dimension);
    let newOffset = 0;
    for (const [id, entry] of this.entriesById.entries()) {
      const oldStart = entry.offset * this.dimension;
      liveVectors.set(this.vectors.subarray(oldStart, oldStart + this.dimension), newOffset * this.dimension);
      persistedEntries[id] = { ...entry.metadata, offset: newOffset };
      newOffset += 1;
    }

    const envelope: FlatStoreMeta<M> & Record<string, unknown> = {
      ...this.extraMeta,
      version: this.version,
      dimension: this.dimension,
      count: this.entriesById.size,
      entries: persistedEntries,
    };
    try {
      await this.sidecarDir.writeJson(this.metaFile, envelope);
      const binPath = this.sidecarDir.getPath(this.binFile);
      const dir = path.dirname(binPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const buffer = Buffer.from(liveVectors.buffer, liveVectors.byteOffset, envelope.count * this.dimension * 4);
      fs.writeFileSync(binPath, buffer);
      // Rewrite our in-memory vectors as the compacted form so
      // subsequent upserts start from a clean offset map.
      this.vectors = liveVectors;
      for (const [id, newMeta] of Object.entries(persistedEntries)) {
        this.entriesById.set(id, { metadata: newMeta as M & { offset: number }, offset: newMeta.offset });
      }
    } catch (err) {
      console.warn('[FlatVectorStore] persist failed:', err);
    }
  }

  async restore(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;
    try {
      const envelope = await this.sidecarDir.readJson<FlatStoreMeta<M> & Record<string, unknown>>(this.metaFile);
      if (!envelope) return;
      if (!this.validateMeta(envelope as FlatStoreMeta<unknown> & Record<string, unknown>)) {
        console.log('[FlatVectorStore] persisted meta failed validation — rebuilding on next write');
        return;
      }
      const binPath = this.sidecarDir.getPath(this.binFile);
      if (!fs.existsSync(binPath)) return;
      const buffer = fs.readFileSync(binPath);
      const expectedBytes = envelope.count * this.dimension * 4;
      if (buffer.byteLength < expectedBytes) {
        console.warn('[FlatVectorStore] persisted vector file too small — rebuilding');
        return;
      }
      this.vectors = new Float32Array(buffer.buffer, buffer.byteOffset, envelope.count * this.dimension);
      this.entriesById.clear();
      for (const [id, entryPlusOffset] of Object.entries(envelope.entries)) {
        const { offset, ...metadata } = entryPlusOffset as M & { offset: number };
        this.entriesById.set(id, { metadata: metadata as M, offset });
      }
    } catch (err) {
      console.warn('[FlatVectorStore] restore failed:', err);
    }
  }

  async clearPersisted(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;
    try {
      const binPath = this.sidecarDir.getPath(this.binFile);
      const metaPath = this.sidecarDir.getPath(this.metaFile);
      if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    } catch (err) {
      console.warn('[FlatVectorStore] clearPersisted failed:', err);
    }
  }
}

/**
 * Cosine similarity between two unit vectors. Exposed so stores that
 * normalize vectors at upsert time can fall back to the dot product
 * (which is what cosine reduces to for unit vectors).
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Error thrown when a caller asks for a backend that isn't
 * implemented in this build (e.g. `backend: 'lance'` before the
 * LanceDB integration lands). Separate type so callers can fall
 * back cleanly — the production wiring catches this and emits a
 * user-facing warning while keeping the flat backend active.
 */
export class UnsupportedBackendError extends Error {
  constructor(
    public readonly requestedBackend: string,
    public readonly fallbackTo: string,
  ) {
    super(
      `Backend "${requestedBackend}" is not available in this build. ` +
        `Using "${fallbackTo}" instead. See sidecar.projectKnowledge.backend.`,
    );
    this.name = 'UnsupportedBackendError';
  }
}
