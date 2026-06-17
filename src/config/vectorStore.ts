/**
 * Backend abstraction for the Project Knowledge Index's vector
 * storage. Pure-TS interface + a flat in-memory
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
import { logger } from '../system/logger.js';
import * as path from 'path';
import type { SidecarDir } from './sidecarDir.js';
import { cosine } from './math.js';

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
  /**
   * Fetch the stored vector for an id — returns null if the id isn't
   * indexed. Added in v0.62 d.2 so secondary indexes (Merkle tree,
   * future reranker caches) can replay existing entries without
   * paying a re-embed. Returns a view-or-copy per implementation —
   * callers must not mutate.
   */
  getVector(id: string): Float32Array | null;
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
  /** Clear all in-memory records AND delete persisted files. The store
   *  is empty and consistent (as if freshly constructed) after this call. */
  clearAll(): Promise<void>;
  /** Sum of on-disk bytes used by this store's persistence files.
   *  Returns 0 when no persistence is configured or files don't exist. */
  getDiskBytes(): Promise<number>;
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
 * persistence. Behavior-identical to the v0.61
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

  /** Packed row-major vector storage. Length = capacity × dimension. */
  private vectors = new Float32Array(0);
  /** Number of slots allocated in `vectors` (monotonically increasing; not decremented on delete). */
  private vectorCount = 0;
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
    // New record — append to the packed vector array, growing capacity
    // with a doubling strategy so amortized cost is O(1) not O(n).
    const offset = this.vectorCount;
    const currentCapacity = this.vectors.length / this.dimension;
    if (offset >= currentCapacity) {
      const newCapacity = Math.max(16, currentCapacity * 2);
      const grown = new Float32Array(newCapacity * this.dimension);
      grown.set(this.vectors.subarray(0, this.vectorCount * this.dimension));
      this.vectors = grown;
    }
    this.vectors.set(record.vector, offset * this.dimension);
    this.vectorCount += 1;
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

    const dim = this.dimension;
    const vecs = this.vectors;
    const hits: VectorSearchHit<M>[] = [];
    for (const [id, entry] of this.entriesById.entries()) {
      if (filter && !filter(entry.metadata)) continue;
      const start = entry.offset * dim;
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += query[i] * vecs[start + i];
      hits.push({ id, metadata: entry.metadata, similarity: dot });
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

  getVector(id: string): Float32Array | null {
    const entry = this.entriesById.get(id);
    if (!entry) return null;
    // `subarray` returns a view over the same buffer — cheap, but
    // means an unwary caller could mutate the backing store. The
    // interface doc warns against that; we don't copy here because
    // the Merkle replay path reads every stored vector at activation
    // and copying each one would double peak memory briefly.
    const start = entry.offset * this.dimension;
    return this.vectors.subarray(start, start + this.dimension);
  }

  *entries(): Iterable<{ id: string; metadata: M }> {
    for (const [id, entry] of this.entriesById.entries()) {
      yield { id, metadata: entry.metadata };
    }
  }

  async persist(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;

    const liveCount = this.entriesById.size;
    const hasOrphans = liveCount < this.vectorCount;
    const persistedEntries: Record<string, M & { offset: number }> = {};
    // Float32Array<ArrayBufferLike> so both `new Float32Array(n)` (ArrayBuffer)
    // and `subarray()` (ArrayBufferLike) are assignable to this variable.
    let liveVectors: Float32Array<ArrayBufferLike>;

    if (hasOrphans) {
      // Compact: copy only live rows and assign sequential offsets so
      // orphan rows from deletes don't waste disk space.
      liveVectors = new Float32Array(liveCount * this.dimension);
      let newOffset = 0;
      for (const [id, entry] of this.entriesById.entries()) {
        const oldStart = entry.offset * this.dimension;
        liveVectors.set(this.vectors.subarray(oldStart, oldStart + this.dimension), newOffset * this.dimension);
        persistedEntries[id] = { ...entry.metadata, offset: newOffset };
        newOffset += 1;
      }
    } else {
      // No orphan rows — the packed array is already compact.
      // Write a subarray view directly; no copy needed.
      liveVectors = this.vectors.subarray(0, liveCount * this.dimension);
      for (const [id, entry] of this.entriesById.entries()) {
        persistedEntries[id] = { ...entry.metadata, offset: entry.offset };
      }
    }

    const envelope: FlatStoreMeta<M> & Record<string, unknown> = {
      ...this.extraMeta,
      version: this.version,
      dimension: this.dimension,
      count: liveCount,
      entries: persistedEntries,
    };
    try {
      await this.sidecarDir.writeJson(this.metaFile, envelope);
      const binPath = this.sidecarDir.getPath(this.binFile);
      const dir = path.dirname(binPath);
      await fs.promises.mkdir(dir, { recursive: true });
      const buffer = Buffer.from(liveVectors.buffer, liveVectors.byteOffset, liveCount * this.dimension * 4);
      await fs.promises.writeFile(binPath, buffer);
      if (hasOrphans) {
        // Apply the new compact offsets back to the in-memory store so
        // subsequent upserts start from a clean offset map.
        this.vectors = liveVectors as Float32Array<ArrayBuffer>;
        this.vectorCount = liveCount;
        for (const [id, newMeta] of Object.entries(persistedEntries)) {
          const { offset: newOffset, ...cleanMeta } = newMeta as M & { offset: number };
          this.entriesById.set(id, { metadata: cleanMeta as M, offset: newOffset });
        }
      }
    } catch (err) {
      logger.warn('[FlatVectorStore] persist failed:', err);
    }
  }

  async restore(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;
    try {
      const binPath = this.sidecarDir.getPath(this.binFile);
      // Read metadata JSON and binary file in parallel — saves one
      // sequential I/O round-trip on every activation.
      const [envelope, rawBuffer] = await Promise.all([
        this.sidecarDir.readJson<FlatStoreMeta<M> & Record<string, unknown>>(this.metaFile),
        fs.promises.readFile(binPath).catch((): Buffer | null => null),
      ]);
      if (!envelope) return;
      if (!this.validateMeta(envelope as FlatStoreMeta<unknown> & Record<string, unknown>)) {
        logger.warn(
          `[FlatVectorStore] persisted meta failed validation (model/dimension changed?) — deleting stale cache and re-indexing`,
        );
        await fs.promises.unlink(this.sidecarDir.getPath(this.metaFile)).catch(() => {});
        await fs.promises.unlink(binPath).catch(() => {});
        return;
      }
      if (!rawBuffer) return; // binary absent — rebuild
      const expectedBytes = envelope.count * this.dimension * 4;
      if (rawBuffer.byteLength < expectedBytes) {
        logger.warn('[FlatVectorStore] persisted vector file too small — rebuilding');
        return;
      }
      this.vectors = new Float32Array(
        rawBuffer.buffer as ArrayBuffer,
        rawBuffer.byteOffset,
        envelope.count * this.dimension,
      );
      this.vectorCount = envelope.count;
      this.entriesById.clear();
      for (const [id, entryPlusOffset] of Object.entries(envelope.entries)) {
        const { offset, ...metadata } = entryPlusOffset as M & { offset: number };
        this.entriesById.set(id, { metadata: metadata as M, offset });
      }
    } catch (err) {
      logger.warn('[FlatVectorStore] restore failed:', err);
    }
  }

  async clearPersisted(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;
    try {
      const binPath = this.sidecarDir.getPath(this.binFile);
      const metaPath = this.sidecarDir.getPath(this.metaFile);
      await fs.promises.unlink(binPath).catch(() => {});
      await fs.promises.unlink(metaPath).catch(() => {});
    } catch (err) {
      logger.warn('[FlatVectorStore] clearPersisted failed:', err);
    }
  }

  async clearAll(): Promise<void> {
    this.vectors = new Float32Array(0);
    this.vectorCount = 0;
    this.entriesById.clear();
    await this.clearPersisted();
  }

  async getDiskBytes(): Promise<number> {
    if (!this.sidecarDir?.isReady()) return 0;
    let total = 0;
    for (const rel of [this.binFile, this.metaFile]) {
      try {
        const stat = await fs.promises.stat(this.sidecarDir.getPath(rel));
        total += stat.size;
      } catch {
        // file doesn't exist yet
      }
    }
    return total;
  }
}

export { cosine };

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

/** Row shape persisted in the Lance table. */
interface LanceRow {
  id: string;
  vector: number[];
  metadata_json: string;
}

/** Minimal structural types for the parts of @lancedb/lancedb we call.
 *  Defined locally because the package is external in the esbuild bundle
 *  (native Rust binary) and may not be installed at all in some builds. */
interface LanceMergeInsert {
  whenMatchedUpdateAll(): LanceMergeInsert;
  whenNotMatchedInsertAll(): LanceMergeInsert;
  execute(rows: LanceRow[]): Promise<void>;
}
interface LanceVectorQuery {
  metric(m: string): LanceVectorQuery;
  limit(k: number): LanceVectorQuery;
  toArray(): Promise<(LanceRow & { _distance: number })[]>;
}
interface LanceTableQuery {
  select(cols: string[]): LanceTableQuery;
  toArray(): Promise<{ id: string; metadata_json: string }[]>;
}
interface LanceTable {
  mergeInsert(on: string): LanceMergeInsert;
  delete(filter: string): Promise<void>;
  vectorSearch(vec: number[]): LanceVectorQuery;
  query(): LanceTableQuery;
}
interface LanceConnection {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceTable>;
  createTable(name: string, rows: LanceRow[]): Promise<LanceTable>;
  dropTable(name: string): Promise<void>;
}
interface LancedbModule {
  connect(path: string): Promise<LanceConnection>;
}

/**
 * LanceDB-backed vector store. Immediately durable — every mutation
 * lands in the Lance table, so `persist()` is a no-op. `restore()`
 * rebuilds the metadata cache from the table on startup.
 *
 * Requires `@lancedb/lancedb` to be installed and available at
 * runtime. The package is kept external in the esbuild bundle
 * (native Rust binary) and loaded via a dynamic `require()` inside
 * a try/catch. If the package isn't present the constructor throws
 * `UnsupportedBackendError` and callers fall back to `FlatVectorStore`.
 */
export class LanceVectorStore<M> implements VectorStore<M> {
  private readonly dbPath: string;
  private readonly tableName: string;
  private readonly dimension: number;
  /** O(1) metadata lookup without reading the Lance table on every call. */
  private readonly metaCache = new Map<string, M>();
  private lancedb: LancedbModule | null = null;
  private db: LanceConnection | null = null;
  private tbl: LanceTable | null = null;

  /**
   * @param dbPath  Absolute path to the Lance database directory.
   * @param tableName  Table name within the database.
   * @param dimension  Vector dimension — must match the embedding model.
   * @param lancedbModule  Optional pre-loaded lancedb module — used by tests
   *   to inject a fake without going through `require`. When omitted, the
   *   constructor loads `@lancedb/lancedb` via `require()`.
   * @throws `UnsupportedBackendError` if `@lancedb/lancedb` is not installed.
   */
  constructor(dbPath: string, tableName: string, dimension: number, lancedbModule?: unknown) {
    if (lancedbModule !== undefined) {
      this.lancedb = lancedbModule as LancedbModule;
    } else {
      try {
        this.lancedb = require('@lancedb/lancedb') as LancedbModule;
      } catch {
        throw new UnsupportedBackendError('lance', 'flat');
      }
    }
    this.dbPath = dbPath;
    this.tableName = tableName;
    this.dimension = dimension;
  }

  private async getTable(): Promise<LanceTable> {
    if (this.tbl) return this.tbl;
    if (!this.db) {
      this.db = await this.lancedb!.connect(this.dbPath);
    }
    const existingNames: string[] = await this.db!.tableNames();
    if (existingNames.includes(this.tableName)) {
      this.tbl = await this.db!.openTable(this.tableName);
    } else {
      // Bootstrap the table with the required schema, then purge the seed row.
      const seed: LanceRow = {
        id: '__init__',
        vector: new Array(this.dimension).fill(0) as number[],
        metadata_json: '{}',
      };
      this.tbl = await this.db!.createTable(this.tableName, [seed]);
      await this.tbl.delete("id = '__init__'");
    }
    return this.tbl!;
  }

  async upsert(record: VectorRecord<M>): Promise<void> {
    if (record.vector.length !== this.dimension) {
      throw new Error(
        `LanceVectorStore.upsert: vector length ${record.vector.length} does not match expected dimension ${this.dimension}`,
      );
    }
    const tbl = await this.getTable();
    const row: LanceRow = {
      id: record.id,
      vector: Array.from(record.vector),
      metadata_json: JSON.stringify(record.metadata),
    };
    await tbl.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([row]);
    this.metaCache.set(record.id, record.metadata);
  }

  async remove(id: string): Promise<boolean> {
    if (!this.metaCache.has(id)) return false;
    const tbl = await this.getTable();
    // Escape single quotes in id to prevent SQL injection in the filter string.
    await tbl.delete(`id = '${id.replace(/'/g, "''")}'`);
    this.metaCache.delete(id);
    return true;
  }

  async removeWhere(predicate: (metadata: M) => boolean): Promise<number> {
    const ids: string[] = [];
    for (const [id, meta] of this.metaCache) {
      if (predicate(meta)) ids.push(id);
    }
    if (ids.length === 0) return 0;
    const tbl = await this.getTable();
    const inClause = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    await tbl.delete(`id IN (${inClause})`);
    for (const id of ids) this.metaCache.delete(id);
    return ids.length;
  }

  async search(query: Float32Array, k: number, filter?: (metadata: M) => boolean): Promise<VectorSearchHit<M>[]> {
    if (this.metaCache.size === 0) return [];
    const tbl = await this.getTable();
    // Fetch more than k when a post-search filter is active so we can
    // still return up to k results after dropping filtered-out rows.
    const fetchK = filter ? Math.min(this.metaCache.size, k * 4) : k;
    const rows = await tbl.vectorSearch(Array.from(query)).metric('cosine').limit(fetchK).toArray();
    const hits: VectorSearchHit<M>[] = [];
    for (const row of rows) {
      const meta = this.metaCache.get(row.id);
      if (!meta) continue; // row predates this session's cache rebuild
      if (filter && !filter(meta)) continue;
      hits.push({ id: row.id, metadata: meta, similarity: 1 - row._distance });
      if (hits.length >= k) break;
    }
    return hits;
  }

  size(): number {
    return this.metaCache.size;
  }

  getMetadata(id: string): M | null {
    return this.metaCache.get(id) ?? null;
  }

  /** Always returns null — Lance stores vectors on disk; fetching them
   *  per-id requires a full scan.  Callers (Merkle replay) re-embed on
   *  cache miss, which is acceptable for the MVP. */
  getVector(_id: string): Float32Array | null {
    return null;
  }

  *entries(): Iterable<{ id: string; metadata: M }> {
    for (const [id, metadata] of this.metaCache) {
      yield { id, metadata };
    }
  }

  /** No-op — Lance writes are immediately durable. */
  async persist(): Promise<void> {}

  /** Rebuild the in-memory metadata cache from the Lance table. */
  async restore(): Promise<void> {
    try {
      const tbl = await this.getTable();
      const rows = await tbl.query().select(['id', 'metadata_json']).toArray();
      this.metaCache.clear();
      for (const row of rows) {
        try {
          this.metaCache.set(row.id, JSON.parse(row.metadata_json) as M);
        } catch {
          // Corrupted row — skip silently; it will be re-embedded.
        }
      }
    } catch (err) {
      logger.warn('[LanceVectorStore] restore failed:', err);
    }
  }

  /** Drop the Lance table entirely and clear the in-memory cache. */
  async clearPersisted(): Promise<void> {
    try {
      if (!this.db) {
        this.db = await this.lancedb!.connect(this.dbPath);
      }
      const names: string[] = await this.db!.tableNames();
      if (names.includes(this.tableName)) {
        await this.db!.dropTable(this.tableName);
      }
    } catch (err) {
      logger.warn('[LanceVectorStore] clearPersisted failed:', err);
    }
    this.tbl = null;
    this.metaCache.clear();
  }

  async clearAll(): Promise<void> {
    await this.clearPersisted();
  }

  async getDiskBytes(): Promise<number> {
    try {
      let total = 0;
      for await (const entry of await fs.promises.readdir(this.dbPath, { withFileTypes: true })) {
        try {
          const stat = await fs.promises.stat(path.join(this.dbPath, entry.name));
          total += stat.size;
        } catch {
          // skip
        }
      }
      return total;
    } catch {
      return 0;
    }
  }
}
