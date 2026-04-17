/**
 * Symbol-level semantic embedding index (v0.61 b.1, part 1 of the
 * Project Knowledge Index feature). Lower-level sibling of
 * [`EmbeddingIndex`](./embeddingIndex.ts): instead of one vector per
 * file, we index one vector per symbol (function, class, method,
 * interface, type, etc.) so queries like "where is auth handled?"
 * return the specific function rather than the whole file.
 *
 * v0.62 c.2 — storage was extracted to a pluggable `VectorStore`
 * interface. This class now owns the embedding pipeline + queue +
 * domain logic (hash short-circuit, kind/path filters) while the
 * actual vector CRUD + persistence delegate to a `VectorStore<SymbolMetadata>`.
 * Default backend is the flat in-memory cosine-scan store; a future
 * release can drop in a LanceDB-backed store with no changes here.
 *
 * Storage: `.sidecar/cache/symbol-embeddings.bin` (packed Float32
 * vectors) + `.sidecar/cache/symbol-embeddings-meta.json` — bit-for-
 * bit compatible with the v0.61 format (caller's `modelId` is
 * preserved via `extraMeta`).
 */

import { Disposable } from 'vscode';
import * as crypto from 'crypto';
import type { SidecarDir } from './sidecarDir.js';
import { FlatVectorStore, type VectorStore, type FlatStoreMeta } from './vectorStore.js';

/**
 * Same model as the file-level index — keeps the embedding space
 * compatible so a single query can score against both backends during
 * the feature-flag migration window.
 */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSION = 384;
const SCHEMA_VERSION = 1;
const META_FILE = 'cache/symbol-embeddings-meta.json';
const BIN_FILE = 'cache/symbol-embeddings.bin';
const MAX_INPUT_CHARS = 4096; // symbols are usually smaller than files — 4k is generous

export interface SymbolEmbedInput {
  /** Workspace-relative path where the symbol lives. */
  filePath: string;
  /** Fully-qualified name (e.g. `AuthMiddleware.requireAuth`). */
  qualifiedName: string;
  /** Short name for the symbol (last segment of the qualified name). */
  name: string;
  /** Symbol kind as reported by `SymbolGraph` — used for `kindFilter`. */
  kind: string;
  /** 1-based start line in the source file. */
  startLine: number;
  /** 1-based end line in the source file. */
  endLine: number;
  /** Symbol body text (function body, class body, etc.) — what we embed. */
  body: string;
}

export interface SymbolSearchResult {
  /** Deterministic ID used as the primary key — `filePath::qualifiedName`. */
  symbolId: string;
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** Cosine similarity in [-1, 1]; normalized vectors usually yield [0, 1]. */
  similarity: number;
}

export interface SymbolSearchFilters {
  /**
   * Restrict results to these symbol kinds. Applied via the store's
   * metadata filter — flat backend scans and filters in-memory; a
   * future Lance backend pushes this into a native WHERE clause.
   */
  kindFilter?: string[];
  /**
   * Glob-style path prefix (e.g. `src/middleware/`). Matches by simple
   * `startsWith` for MVP; full glob semantics ship with the LanceDB
   * backend in a later step.
   */
  pathPrefix?: string;
}

/**
 * Domain metadata persisted per symbol alongside the vector. Stored
 * as `M` in the underlying `VectorStore<SymbolMetadata>`. The `hash`
 * field drives the re-embed short-circuit — if a file save re-feeds
 * the same symbol body, we skip the embed entirely.
 */
export interface SymbolMetadata {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** MD5 prefix of the embedded body. Skip-on-match lets a whole-
   *  workspace re-scan cost near-zero when nothing actually changed. */
  hash: string;
}

type EmbeddingPipeline = (
  texts: string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

export class SymbolEmbeddingIndex implements Disposable {
  private pipeline: EmbeddingPipeline | null = null;
  private modelLoading: Promise<void> | null = null;
  private ready = false;

  /**
   * Pluggable storage backend (v0.62 c.2). Default: the flat in-
   * memory cosine-scan store. A constructor overload lets tests or
   * a future Lance wiring inject a different `VectorStore<SymbolMetadata>`
   * without touching this class's public API.
   */
  private store: VectorStore<SymbolMetadata>;

  /** True when a mutation has landed since the last successful persist. */
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PERSIST_DEBOUNCE_MS = 30_000;

  /**
   * Pending-embed queue (v0.61 b.2). `queueSymbol` adds to it;
   * `flushQueue` drains in batches so a workspace-scan doesn't
   * serialize on one embed at a time. Keyed by `symbolId` so the
   * most-recent input wins when a file is updated twice in quick
   * succession (save-after-save coalesces).
   */
  private pendingQueue = new Map<string, SymbolEmbedInput>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_DEBOUNCE_MS = 500;
  private static readonly FLUSH_BATCH_SIZE = 20;

  /**
   * Construct with the default flat backend, or inject a custom
   * `VectorStore<SymbolMetadata>` (e.g. for Lance once it lands, or
   * a stub in unit tests). The default store preserves the v0.61
   * on-disk format via `extraMeta: { modelId }` — no cache rebuild
   * is required when upgrading past c.2.
   */
  constructor(sidecarDir: SidecarDir | null, store?: VectorStore<SymbolMetadata>) {
    this.store =
      store ??
      new FlatVectorStore<SymbolMetadata>(sidecarDir, {
        dimension: DIMENSION,
        version: SCHEMA_VERSION,
        binFile: BIN_FILE,
        metaFile: META_FILE,
        extraMeta: { modelId: MODEL_ID },
        validateMeta: (meta) => {
          // Reject caches from a different model (embedding space
          // wouldn't match) or a schema bump. Version + dimension
          // are already checked by the default validator; we add the
          // modelId check because it's domain-specific.
          const envelope = meta as FlatStoreMeta<unknown> & { modelId?: string };
          return (
            envelope.version === SCHEMA_VERSION && envelope.dimension === DIMENSION && envelope.modelId === MODEL_ID
          );
        },
      });
  }

  /** True when the embedding model is loaded and the index is ready
   *  to serve queries. Callers should fall back to keyword search if
   *  this is false (model may still be loading). */
  isReady(): boolean {
    return this.ready && this.pipeline !== null;
  }

  /**
   * Restore cache from disk + start the model load in the background.
   * Returns immediately — callers that need the model ready must check
   * `isReady()` or await the `modelLoading` promise via `ensureModel`.
   */
  async initialize(): Promise<void> {
    await this.store.restore();
    this.modelLoading = this.loadModel();
    this.modelLoading.catch((err) => {
      console.warn('[SideCar] Symbol embedding model failed to load:', err?.message || err);
    });
  }

  /**
   * Test-only hook: inject a pre-built embedding pipeline so unit tests
   * don't need to load the real ONNX model (that'd be 23MB + seconds of
   * boot per suite). Production callers use `initialize()` instead.
   */
  setPipelineForTests(pipeline: EmbeddingPipeline | null): void {
    this.pipeline = pipeline;
    this.ready = pipeline !== null;
  }

  private async loadModel(): Promise<void> {
    try {
      const { pipeline: createPipeline, env } = await import('@xenova/transformers');
      // The sidecarDir path still belongs to the caller's world; the
      // store encapsulates vector storage only.
      env.allowRemoteModels = true;
      this.pipeline = (await createPipeline('feature-extraction', MODEL_ID, {
        quantized: true,
      })) as unknown as EmbeddingPipeline;
      this.ready = true;
    } catch (err) {
      this.ready = false;
      throw err;
    }
  }

  private async ensureModel(): Promise<boolean> {
    if (this.pipeline) return true;
    if (this.modelLoading) {
      try {
        await this.modelLoading;
        return this.pipeline !== null;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Produce a normalized 384-dim embedding for `text`. Returns null
   * when the model isn't available — callers treat this as "skip,
   * try again when ready" rather than an error.
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!(await this.ensureModel()) || !this.pipeline) return null;
    const truncated = text.slice(0, MAX_INPUT_CHARS);
    const output = await this.pipeline([truncated], { pooling: 'mean', normalize: true });
    return new Float32Array(output.data.slice(0, DIMENSION));
  }

  /**
   * Embed + store a single symbol. Idempotent: re-calling with the
   * same body (same hash) is a cheap no-op so the indexing pipeline
   * can re-scan a whole file after a save without paying to re-embed
   * every unchanged symbol.
   */
  async indexSymbol(input: SymbolEmbedInput): Promise<void> {
    const symbolId = makeSymbolId(input.filePath, input.qualifiedName);
    const hash = hashBody(input.body);

    const existing = this.store.getMetadata(symbolId);
    if (existing && existing.hash === hash) return; // unchanged — skip re-embed

    // Prefix the body with the symbol's structural context so queries
    // like "auth middleware" match even when the body text doesn't
    // use those words verbatim (e.g. a `requireAuth` function whose
    // body only calls `verifyToken`). Matches the file-level index
    // convention of prepending the path.
    const embedInput = `${input.qualifiedName} (${input.kind})\n${input.body}`;
    const vector = await this.embed(embedInput);
    if (!vector) return; // model not ready — caller can retry later

    await this.store.upsert({
      id: symbolId,
      vector,
      metadata: {
        filePath: input.filePath,
        qualifiedName: input.qualifiedName,
        name: input.name,
        kind: input.kind,
        startLine: input.startLine,
        endLine: input.endLine,
        hash,
      },
    });
    this.dirty = true;
    this.schedulePersist();
  }

  /**
   * Queue a symbol for embedding (v0.61 b.2). Debounced batch drain
   * means a whole-workspace scan queues thousands of symbols upfront
   * without awaiting each embed inline. Re-queueing the same symbol
   * with new body overwrites the pending entry — the most-recent
   * version wins.
   */
  queueSymbol(input: SymbolEmbedInput): void {
    const id = makeSymbolId(input.filePath, input.qualifiedName);
    this.pendingQueue.set(id, input);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushQueue(), SymbolEmbeddingIndex.FLUSH_DEBOUNCE_MS);
    }
  }

  /**
   * Drain up to one batch of queued symbols through `indexSymbol`.
   * Auto-reschedules if anything's still queued, so a big workspace
   * scan trickles through without saturating the embedding model.
   */
  private async flushQueue(): Promise<void> {
    this.flushTimer = null;
    if (this.pendingQueue.size === 0) return;
    if (!(await this.ensureModel())) {
      // Model still loading — try again after the debounce window.
      this.flushTimer = setTimeout(() => this.flushQueue(), SymbolEmbeddingIndex.FLUSH_DEBOUNCE_MS);
      return;
    }

    const batch = Array.from(this.pendingQueue.entries()).slice(0, SymbolEmbeddingIndex.FLUSH_BATCH_SIZE);
    for (const [id] of batch) this.pendingQueue.delete(id);
    for (const [, input] of batch) {
      try {
        await this.indexSymbol(input);
      } catch (err) {
        // Per-symbol embed failure shouldn't kill the whole batch.
        console.warn(`[SideCar] Symbol embed failed for ${input.filePath}::${input.qualifiedName}:`, err);
      }
    }

    if (this.pendingQueue.size > 0) {
      this.flushTimer = setTimeout(() => this.flushQueue(), SymbolEmbeddingIndex.FLUSH_DEBOUNCE_MS);
    }
  }

  /**
   * Test-only: force-drain the queue immediately, skipping the
   * debounce timer. Production code shouldn't call this — the
   * debounced flush is the contract.
   */
  async flushQueueForTests(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain repeatedly until empty so a test doesn't need to know
    // about the internal batch size.
    while (this.pendingQueue.size > 0) {
      await this.flushQueue();
    }
  }

  /** Drop a symbol by `symbolId`. No-op if the symbol isn't indexed. */
  removeSymbol(symbolId: string): void {
    // Fire-and-forget — the store mutation is in-memory (flat) or
    // async (Lance) but not a cost center either way. Matches the
    // v0.61 sync signature so every existing caller keeps working.
    void this.store.remove(symbolId).then((removed) => {
      if (removed) {
        this.dirty = true;
        this.schedulePersist();
      }
    });
  }

  /**
   * Drop every symbol that lives in the named file. Called by the
   * file-change pipeline on delete/rename. Also drops any queued-but-
   * not-yet-indexed entries from this file so a delete-then-queue
   * race doesn't leave stale records.
   *
   * Returns a count matching the v0.61 sync contract. Because the
   * underlying store's `removeWhere` is async, we use a synchronous
   * mirror via `entries()` to compute the count up front, then kick
   * off the actual removes in the background. The mirror is always
   * accurate for the flat backend; a future Lance backend will need
   * to either return a sync count itself or we'll relax this signature.
   */
  removeFile(filePath: string): number {
    let removed = 0;
    const toRemove: string[] = [];
    for (const entry of this.store.entries()) {
      if (entry.metadata.filePath === filePath) {
        toRemove.push(entry.id);
        removed += 1;
      }
    }
    for (const id of toRemove) void this.store.remove(id);
    // Also drop queued-but-not-yet-indexed symbols from this file.
    for (const [id, input] of this.pendingQueue.entries()) {
      if (input.filePath === filePath) this.pendingQueue.delete(id);
    }
    if (removed > 0) {
      this.dirty = true;
      this.schedulePersist();
    }
    return removed;
  }

  /**
   * Return the top-`topK` symbols by cosine similarity to `query`.
   * Metadata filters translate to the store's `filter` predicate so
   * a Lance backend later can push them into the native query plan.
   */
  async search(query: string, topK = 20, filters?: SymbolSearchFilters): Promise<SymbolSearchResult[]> {
    if (!this.isReady() || this.store.size() === 0) return [];
    const queryVec = await this.embed(query);
    if (!queryVec) return [];

    const hasKindFilter = filters?.kindFilter && filters.kindFilter.length > 0;
    const filter =
      hasKindFilter || filters?.pathPrefix
        ? (meta: SymbolMetadata) => {
            if (hasKindFilter && !filters!.kindFilter!.includes(meta.kind)) return false;
            if (filters?.pathPrefix && !meta.filePath.startsWith(filters.pathPrefix)) return false;
            return true;
          }
        : undefined;

    const hits = await this.store.search(queryVec, topK, filter);
    return hits.map((h) => ({
      symbolId: h.id,
      filePath: h.metadata.filePath,
      qualifiedName: h.metadata.qualifiedName,
      name: h.metadata.name,
      kind: h.metadata.kind,
      startLine: h.metadata.startLine,
      endLine: h.metadata.endLine,
      similarity: h.similarity,
    }));
  }

  /** Total number of indexed symbols. */
  getCount(): number {
    return this.store.size();
  }

  /** Look up one symbol's metadata by ID. Handy for callers that got
   *  a `symbolId` from somewhere else and need its location. The
   *  return type includes `offset` for v0.61 compatibility but the
   *  field is meaningless against a non-flat backend; callers that
   *  only need location-level fields should ignore it. */
  getSymbolMeta(symbolId: string): (SymbolMetadata & { offset: number }) | null {
    const metadata = this.store.getMetadata(symbolId);
    if (!metadata) return null;
    // `offset` was an internal implementation detail pre-c.2; kept
    // in the shape for API compatibility and always reported as 0
    // for non-flat backends.
    return { ...metadata, offset: 0 };
  }

  // ---------------------------------------------------------------------------
  // Persistence — delegate to the store; schedulePersist preserves v0.61
  // debounce semantics so unchanged callers see the same write cadence.
  // ---------------------------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persist(), SymbolEmbeddingIndex.PERSIST_DEBOUNCE_MS);
  }

  async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty) return;
    await this.store.persist();
    this.dirty = false;
  }

  dispose(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.dirty) {
      try {
        void this.persist();
      } catch {
        /* best-effort shutdown cleanup */
      }
    }
  }
}

/**
 * Deterministic ID for a symbol — stable across restarts as long as
 * the file path + qualified name haven't changed. Renames produce a
 * new ID, which means the old row becomes an orphan until the next
 * `removeFile(...)` sweep; acceptable since the vector cost of an
 * orphan is a few hundred bytes.
 */
export function makeSymbolId(filePath: string, qualifiedName: string): string {
  return `${filePath}::${qualifiedName}`;
}

function hashBody(body: string): string {
  return crypto.createHash('md5').update(body.slice(0, MAX_INPUT_CHARS)).digest('hex').slice(0, 12);
}

/**
 * Cosine similarity between two unit vectors. Re-exported from the
 * vector store module so existing v0.61 importers that pulled this
 * from `symbolEmbeddingIndex.ts` don't break. New code should import
 * from `vectorStore.ts` directly.
 */
export { cosine } from './vectorStore.js';
