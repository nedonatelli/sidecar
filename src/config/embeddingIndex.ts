/**
 * Semantic embedding index for workspace files.
 *
 * Uses @huggingface/transformers to run a small ONNX embedding model (all-MiniLM-L6-v2)
 * locally. Each file's content is embedded into a 384-dimensional vector and
 * stored in a binary cache. Queries are embedded at search time and compared
 * via cosine similarity against the cached vectors.
 *
 * The model (~23MB) is downloaded on first use and cached by the transformers
 * library. Until it's ready, the workspace index falls back to keyword scoring.
 */

import { Disposable } from 'vscode';
import { logger } from '../system/logger.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { SidecarDir } from './sidecarDir.js';
import { cosine } from './math.js';
import { MINILM_MODEL_ID as MODEL_ID, LazyEmbedder } from './hfPipeline.js';
const DIMENSION = 384;
const META_FILE = 'cache/embeddings-meta.json';
const BIN_FILE = 'cache/embeddings.bin';
const MAX_INPUT_CHARS = 2048; // ~512 tokens
const PERSIST_DEBOUNCE_MS = 30_000;
const UPDATE_DEBOUNCE_MS = 500;
const BATCH_SIZE = 20;
const FLUSH_CONCURRENCY = 4;

export interface EmbeddingSearchResult {
  relativePath: string;
  similarity: number;
}

interface EmbeddingMeta {
  version: number;
  modelId: string;
  dimension: number;
  count: number;
  entries: Record<string, { offset: number; hash: string }>;
}

export class EmbeddingIndex implements Disposable {
  private sidecarDir: SidecarDir | null;
  private embedder = new LazyEmbedder({
    label: 'EmbeddingIndex',
    dimension: DIMENSION,
    maxChars: MAX_INPUT_CHARS,
    // Evaluated at load time, after the constructor has set sidecarDir.
    envOpts: () => ({
      cacheDir: this.sidecarDir?.isReady() ? this.sidecarDir.getPath('cache', 'models') : undefined,
      allowRemoteModels: true,
    }),
  });

  // In-memory embedding store
  private vectors = new Float32Array(0);
  private meta: EmbeddingMeta = {
    version: 1,
    modelId: MODEL_ID,
    dimension: DIMENSION,
    count: 0,
    entries: {},
  };

  // Update queue
  private pendingUpdates = new Map<string, string>(); // path -> content
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  // Cap on concurrent readFile calls triggered by queuePath so a burst of
  // file-watcher events can't exhaust the OS file-descriptor limit.
  private activeReads = 0;
  private static readonly MAX_CONCURRENT_READS = 16;

  constructor(sidecarDir: SidecarDir | null) {
    this.sidecarDir = sidecarDir;
  }

  /** Whether the embedding index is ready for queries. */
  isReady(): boolean {
    return this.embedder.ready;
  }

  /**
   * Initialize: restore cache from disk and start loading the model.
   * The model loads in the background — the extension is usable immediately.
   */
  async initialize(): Promise<void> {
    await this.restoreCache();
    // Load in the background; the extension works with keyword scoring until ready.
    this.embedder.start();
  }

  /**
   * Compute embedding for a text string.
   * Returns a Float32Array of length DIMENSION, or null if model unavailable.
   */
  embed(text: string): Promise<Float32Array | null> {
    return this.embedder.embed(text);
  }

  /**
   * Queue a file for embedding with known content.
   * Updates are debounced and processed in batches.
   */
  queueUpdate(relativePath: string, content: string): void {
    this.pendingUpdates.set(relativePath, content);
    if (this.pendingUpdates.size >= BATCH_SIZE && this.updateTimer) {
      // Queue already full — collapse the pending debounce to a 0ms tick
      // so the flush fires on the next event-loop turn instead of waiting
      // the full 500ms. Keeps one timer in flight; no concurrent flushes.
      clearTimeout(this.updateTimer);
      this.updateTimer = setTimeout(() => this.flushUpdates(), 0);
    } else if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => this.flushUpdates(), UPDATE_DEBOUNCE_MS);
    }
  }

  /**
   * Queue a file for embedding by path (reads content from disk).
   * Used by file watchers that only have the path.
   */
  queuePath(relativePath: string, rootPath: string): void {
    if (this.activeReads >= EmbeddingIndex.MAX_CONCURRENT_READS) {
      // Drop the read — the file watcher will re-fire on the next save.
      return;
    }
    this.activeReads++;
    const absPath = path.join(rootPath, relativePath);
    fs.promises
      .readFile(absPath, 'utf-8')
      .then((content) => this.queueUpdate(relativePath, content.slice(0, MAX_INPUT_CHARS)))
      .catch(() => {
        // File may have been deleted or be unreadable — skip
      })
      .finally(() => {
        this.activeReads--;
      });
  }

  /** Remove a file from the embedding index. */
  removeFile(relativePath: string): void {
    if (relativePath in this.meta.entries) {
      delete this.meta.entries[relativePath];
      this.meta.count = Object.keys(this.meta.entries).length;
      this.dirty = true;
      this.schedulePersist();
    }
    this.pendingUpdates.delete(relativePath);
  }

  private async flushUpdates(): Promise<void> {
    this.updateTimer = null;
    if (this.pendingUpdates.size === 0) return;
    if (!(await this.embedder.ensureReady())) return;

    const batch = Array.from(this.pendingUpdates.entries()).slice(0, BATCH_SIZE);
    for (const [relPath] of batch) {
      this.pendingUpdates.delete(relPath);
    }

    // Run up to FLUSH_CONCURRENCY embeds in parallel. storeVector is
    // synchronous (no awaits), so concurrent workers serialize their
    // mutations on the event loop without clobbering each other's offsets.
    let cursor = 0;
    const self = this;
    async function worker(): Promise<void> {
      while (true) {
        const idx = cursor;
        if (idx >= batch.length) return;
        cursor += 1;
        const entry = batch[idx]!;
        const [relPath, content] = entry;
        const hash = self.contentHash(content);
        const existing = self.meta.entries[relPath];
        if (existing && existing.hash === hash) continue;
        const input = `${relPath}\n${content.slice(0, MAX_INPUT_CHARS)}`;
        const vector = await self.embed(input);
        if (!vector) continue;
        self.storeVector(relPath, vector, hash);
      }
    }
    const workerCount = Math.min(FLUSH_CONCURRENCY, batch.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (this.pendingUpdates.size > 0) {
      const delay = this.pendingUpdates.size >= BATCH_SIZE ? 0 : UPDATE_DEBOUNCE_MS;
      this.updateTimer = setTimeout(() => this.flushUpdates(), delay);
    }
  }

  private storeVector(relativePath: string, vector: Float32Array, hash: string): void {
    const existing = this.meta.entries[relativePath];
    if (existing) {
      // Overwrite in place
      this.vectors.set(vector, existing.offset * DIMENSION);
    } else {
      // Append to the end
      const offset = this.meta.count;
      const newVectors = new Float32Array((offset + 1) * DIMENSION);
      newVectors.set(this.vectors);
      newVectors.set(vector, offset * DIMENSION);
      this.vectors = newVectors;
      this.meta.entries[relativePath] = { offset, hash };
      this.meta.count = offset + 1;
    }
    this.dirty = true;
    this.schedulePersist();
  }

  /**
   * Search for files most similar to the query.
   * Returns up to topK results sorted by cosine similarity (descending).
   */
  async search(query: string, topK = 20): Promise<EmbeddingSearchResult[]> {
    if (!this.isReady() || this.meta.count === 0) return [];

    const queryVec = await this.embed(query);
    if (!queryVec) return [];

    const results: EmbeddingSearchResult[] = [];
    for (const [relPath, entry] of Object.entries(this.meta.entries)) {
      const start = entry.offset * DIMENSION;
      const fileVec = this.vectors.subarray(start, start + DIMENSION);
      const sim = cosine(queryVec, fileVec);
      results.push({ relativePath: relPath, similarity: sim });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /** Get the number of embedded files. */
  getCount(): number {
    return this.meta.count;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persist(), PERSIST_DEBOUNCE_MS);
  }

  async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty || !this.sidecarDir?.isReady()) return;

    try {
      await this.sidecarDir.writeJson(META_FILE, this.meta);

      // Write binary vectors using fs directly (not JSON)
      const binPath = this.sidecarDir.getPath(BIN_FILE);
      const dir = path.dirname(binPath);
      await fs.promises.mkdir(dir, { recursive: true });
      const buffer = Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.meta.count * DIMENSION * 4);
      await fs.promises.writeFile(binPath, buffer);

      this.dirty = false;
      logger.info(`[SideCar] Embedding index persisted: ${this.meta.count} vectors`);
    } catch (err) {
      logger.warn('[SideCar] Failed to persist embedding index:', err);
    }
  }

  private async restoreCache(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;

    try {
      const meta = await this.sidecarDir.readJson<EmbeddingMeta>(META_FILE);
      if (!meta) return;

      if (meta.version !== 1 || meta.modelId !== MODEL_ID || meta.dimension !== DIMENSION) {
        logger.warn(
          `[SideCar] Embedding cache mismatch (cached: ${meta.modelId}/${meta.dimension}d, current: ${MODEL_ID}/${DIMENSION}d) — deleting stale cache and re-indexing`,
        );
        // Delete stale files so we don't repeatedly load-and-discard them
        try {
          await fs.promises.unlink(this.sidecarDir!.getPath(META_FILE));
        } catch {
          /* already gone */
        }
        try {
          await fs.promises.unlink(this.sidecarDir!.getPath(BIN_FILE));
        } catch {
          /* already gone */
        }
        return;
      }

      // Read binary vectors
      const binPath = this.sidecarDir.getPath(BIN_FILE);
      let buffer: Buffer;
      try {
        buffer = await fs.promises.readFile(binPath);
      } catch {
        return; // file absent — rebuild
      }
      if (buffer.byteLength < meta.count * DIMENSION * 4) {
        logger.warn('[SideCar] Embedding binary too small, rebuilding');
        return;
      }

      this.vectors = new Float32Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, meta.count * DIMENSION);
      this.meta = meta;
      logger.info(`[SideCar] Embedding cache restored: ${meta.count} vectors`);
    } catch (err) {
      logger.warn('[SideCar] Failed to restore embedding cache:', err);
    }
  }

  private contentHash(content: string): string {
    return crypto.createHash('md5').update(content.slice(0, MAX_INPUT_CHARS)).digest('hex').slice(0, 12);
  }

  dispose(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    // Best-effort persist on shutdown
    if (this.dirty && this.sidecarDir) {
      try {
        this.persist();
      } catch {
        /* shutdown cleanup is best-effort */
      }
    }
  }
}

export { cosine };
