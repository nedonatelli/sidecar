/**
 * Symbol-level semantic embedding index (v0.61 b.1, part 1 of the
 * Project Knowledge Index feature). Lower-level sibling of
 * [`EmbeddingIndex`](./embeddingIndex.ts): instead of one vector per
 * file, we index one vector per symbol (function, class, method,
 * interface, type, etc.) so queries like "where is auth handled?"
 * return the specific function rather than the whole file.
 *
 * This class is the storage + similarity primitive only. Chunking
 * (getting symbol bodies from the workspace) and change-event wiring
 * ship in step b.2; the `project_knowledge_search` tool and graph-
 * walk retrieval enrichment follow in b.3 / b.4. Keeping the primitive
 * standalone means tests can drive it against synthetic symbol inputs
 * without a running tree-sitter pipeline.
 *
 * Storage: `.sidecar/cache/symbol-embeddings.bin` (packed Float32
 * vectors, same shape as the file-level index — flat cosine scan for
 * now, LanceDB-backed ANN comes later in the PKI arc).
 */

import { Disposable } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { SidecarDir } from './sidecarDir.js';

/**
 * Same model as the file-level index — keeps the embedding space
 * compatible so a single query can score against both backends during
 * the feature-flag migration window.
 */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSION = 384;
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
   * Restrict results to these symbol kinds. Applied post-cosine since
   * the flat store can't do efficient metadata filtering — the
   * LanceDB migration replaces this with a native WHERE clause.
   */
  kindFilter?: string[];
  /**
   * Glob-style path prefix (e.g. `src/middleware/`). Matches by simple
   * `startsWith` for MVP; full glob semantics ship with the LanceDB
   * backend in a later step.
   */
  pathPrefix?: string;
}

interface SymbolMeta {
  /** Schema version — bump on breaking shape change. */
  version: number;
  modelId: string;
  dimension: number;
  count: number;
  /** One record per indexed symbol, keyed by `symbolId`. */
  entries: Record<string, SymbolEntryMeta>;
}

interface SymbolEntryMeta {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** Content hash of the embedded body — lets the indexer skip
   *  re-embed when a file save didn't touch this symbol. */
  hash: string;
  /** Row offset into the packed `vectors` Float32Array. */
  offset: number;
}

type EmbeddingPipeline = (
  texts: string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

export class SymbolEmbeddingIndex implements Disposable {
  private sidecarDir: SidecarDir | null;
  private pipeline: EmbeddingPipeline | null = null;
  private modelLoading: Promise<void> | null = null;
  private ready = false;

  private vectors = new Float32Array(0);
  private meta: SymbolMeta = {
    version: 1,
    modelId: MODEL_ID,
    dimension: DIMENSION,
    count: 0,
    entries: {},
  };

  /** True when `indexSymbol` / `removeSymbol` / `removeFile` has
   *  mutated state since the last successful persist. */
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

  constructor(sidecarDir: SidecarDir | null) {
    this.sidecarDir = sidecarDir;
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
    await this.restoreCache();
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
      if (this.sidecarDir?.isReady()) {
        env.cacheDir = this.sidecarDir.getPath('cache', 'models');
      }
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

    const existing = this.meta.entries[symbolId];
    if (existing && existing.hash === hash) return; // unchanged — skip re-embed

    // Prefix the body with the symbol's structural context so queries
    // like "auth middleware" match even when the body text doesn't
    // use those words verbatim (e.g. a `requireAuth` function whose
    // body only calls `verifyToken`). Matches the file-level index
    // convention of prepending the path.
    const embedInput = `${input.qualifiedName} (${input.kind})\n${input.body}`;
    const vector = await this.embed(embedInput);
    if (!vector) return; // model not ready — caller can retry later

    this.storeVector(symbolId, vector, hash, input);
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
    if (!(symbolId in this.meta.entries)) return;
    delete this.meta.entries[symbolId];
    this.meta.count = Object.keys(this.meta.entries).length;
    this.dirty = true;
    this.schedulePersist();
  }

  /**
   * Drop every symbol that lives in the named file. Called by the
   * file-change pipeline on delete/rename — a file-level invalidation
   * is cheaper than tracking per-symbol file provenance separately.
   * Note: this leaves stale vector rows in the packed array; the
   * next persist rewrites the whole file anyway so the gap is harmless.
   */
  removeFile(filePath: string): number {
    let removed = 0;
    for (const [symbolId, entry] of Object.entries(this.meta.entries)) {
      if (entry.filePath === filePath) {
        delete this.meta.entries[symbolId];
        removed += 1;
      }
    }
    // Also drop any queued-but-not-yet-indexed symbols from this file
    // so a delete-then-queue race doesn't leave stale entries.
    for (const [id, input] of this.pendingQueue.entries()) {
      if (input.filePath === filePath) this.pendingQueue.delete(id);
    }
    if (removed > 0) {
      this.meta.count = Object.keys(this.meta.entries).length;
      this.dirty = true;
      this.schedulePersist();
    }
    return removed;
  }

  /**
   * Return the top-`topK` symbols by cosine similarity to `query`.
   * Filters apply after the cosine pass for this MVP; the LanceDB
   * backend planned for step b.5 moves them into the native WHERE
   * clause for O(matching) instead of O(all).
   */
  async search(query: string, topK = 20, filters?: SymbolSearchFilters): Promise<SymbolSearchResult[]> {
    if (!this.isReady() || this.meta.count === 0) return [];
    const queryVec = await this.embed(query);
    if (!queryVec) return [];

    const results: SymbolSearchResult[] = [];
    for (const [symbolId, entry] of Object.entries(this.meta.entries)) {
      if (filters?.kindFilter && !filters.kindFilter.includes(entry.kind)) continue;
      if (filters?.pathPrefix && !entry.filePath.startsWith(filters.pathPrefix)) continue;
      const start = entry.offset * DIMENSION;
      const symVec = this.vectors.subarray(start, start + DIMENSION);
      const sim = cosine(queryVec, symVec);
      results.push({
        symbolId,
        filePath: entry.filePath,
        qualifiedName: entry.qualifiedName,
        name: entry.name,
        kind: entry.kind,
        startLine: entry.startLine,
        endLine: entry.endLine,
        similarity: sim,
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /** Total number of indexed symbols. */
  getCount(): number {
    return this.meta.count;
  }

  /** Look up one symbol's metadata by ID. Handy for callers that got
   *  a `symbolId` from somewhere else and need its location. */
  getSymbolMeta(symbolId: string): SymbolEntryMeta | null {
    return this.meta.entries[symbolId] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Vector storage — append-only offsets, overwrite-in-place on re-embed.
  // ---------------------------------------------------------------------------

  private storeVector(symbolId: string, vector: Float32Array, hash: string, input: SymbolEmbedInput): void {
    const existing = this.meta.entries[symbolId];
    if (existing) {
      this.vectors.set(vector, existing.offset * DIMENSION);
      this.meta.entries[symbolId] = { ...existing, hash, ...toEntryMeta(input) };
    } else {
      const offset = this.meta.count;
      const newVectors = new Float32Array((offset + 1) * DIMENSION);
      newVectors.set(this.vectors);
      newVectors.set(vector, offset * DIMENSION);
      this.vectors = newVectors;
      this.meta.entries[symbolId] = { ...toEntryMeta(input), hash, offset };
      this.meta.count = offset + 1;
    }
    this.dirty = true;
    this.schedulePersist();
  }

  // ---------------------------------------------------------------------------
  // Persistence — same shape as EmbeddingIndex but different paths.
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
    if (!this.dirty || !this.sidecarDir?.isReady()) return;

    try {
      await this.sidecarDir.writeJson(META_FILE, this.meta);
      const binPath = this.sidecarDir.getPath(BIN_FILE);
      const dir = path.dirname(binPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const buffer = Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.meta.count * DIMENSION * 4);
      fs.writeFileSync(binPath, buffer);
      this.dirty = false;
    } catch (err) {
      console.warn('[SideCar] Failed to persist symbol embedding index:', err);
    }
  }

  private async restoreCache(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;
    try {
      const meta = await this.sidecarDir.readJson<SymbolMeta>(META_FILE);
      if (!meta) return;
      if (meta.version !== 1 || meta.modelId !== MODEL_ID || meta.dimension !== DIMENSION) {
        console.log('[SideCar] Symbol embedding cache version/model mismatch, rebuilding');
        return;
      }
      const binPath = this.sidecarDir.getPath(BIN_FILE);
      if (!fs.existsSync(binPath)) return;
      const buffer = fs.readFileSync(binPath);
      if (buffer.byteLength < meta.count * DIMENSION * 4) {
        console.warn('[SideCar] Symbol embedding binary too small, rebuilding');
        return;
      }
      this.vectors = new Float32Array(buffer.buffer, buffer.byteOffset, meta.count * DIMENSION);
      this.meta = meta;
      console.log(`[SideCar] Symbol embedding cache restored: ${meta.count} symbols`);
    } catch (err) {
      console.warn('[SideCar] Failed to restore symbol embedding cache:', err);
    }
  }

  dispose(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.dirty && this.sidecarDir) {
      try {
        this.persist();
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

function toEntryMeta(input: SymbolEmbedInput): Omit<SymbolEntryMeta, 'hash' | 'offset'> {
  return {
    filePath: input.filePath,
    qualifiedName: input.qualifiedName,
    name: input.name,
    kind: input.kind,
    startLine: input.startLine,
    endLine: input.endLine,
  };
}

/**
 * Cosine similarity between two unit vectors. Duplicates the helper
 * in `embeddingIndex.ts` rather than importing it so the two modules
 * stay independently loadable — PKI can ship with `flat` backend
 * disabled without dragging the file-level index along.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
