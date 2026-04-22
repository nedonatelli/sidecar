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
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { SidecarDir } from './sidecarDir.js';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSION = 384;
const META_FILE = 'cache/embeddings-meta.json';
const BIN_FILE = 'cache/embeddings.bin';
const MAX_INPUT_CHARS = 2048; // ~512 tokens
const PERSIST_DEBOUNCE_MS = 30_000;
const UPDATE_DEBOUNCE_MS = 500;
const BATCH_SIZE = 20;

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

// Type for the pipeline function from @huggingface/transformers
type EmbeddingPipeline = (
  texts: string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

export class EmbeddingIndex implements Disposable {
  private sidecarDir: SidecarDir | null;
  private pipeline: EmbeddingPipeline | null = null;
  private modelLoading: Promise<void> | null = null;
  private ready = false;

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

  constructor(sidecarDir: SidecarDir | null) {
    this.sidecarDir = sidecarDir;
  }

  /** Whether the embedding index is ready for queries. */
  isReady(): boolean {
    return this.ready && this.pipeline !== null;
  }

  /**
   * Initialize: restore cache from disk and start loading the model.
   * The model loads in the background — the extension is usable immediately.
   */
  async initialize(): Promise<void> {
    await this.restoreCache();
    this.modelLoading = this.loadModel();
    // Don't await — let it load in the background
    this.modelLoading.catch((err) => {
      console.warn('[SideCar] Embedding model failed to load:', err.message || err);
      // Extension continues working with keyword scoring only
    });
  }

  private async loadModel(): Promise<void> {
    try {
      // Dynamic import to avoid blocking extension activation
      const { pipeline: createPipeline, env } = await import('@huggingface/transformers');

      // Use the extension's cache directory if available
      if (this.sidecarDir?.isReady()) {
        const cacheDir = this.sidecarDir.getPath('cache', 'models');
        env.cacheDir = cacheDir;
      }
      // Allow downloading models from HuggingFace Hub
      env.allowRemoteModels = true;

      // v0.65 — @huggingface/transformers@4 replaced the boolean `quantized`
      // flag with an explicit `dtype` enum. Pin `q8` so the same 8-bit
      // quantized ONNX weights load as under v2's `quantized: true`;
      // without this, v4 silently falls back to fp32 and the embeddings
      // drift enough to fail the parity gate.
      this.pipeline = (await createPipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
      })) as unknown as EmbeddingPipeline;
      this.ready = true;
      console.log('[SideCar] Embedding model loaded:', MODEL_ID);
    } catch (err) {
      this.ready = false;
      throw err;
    }
  }

  /**
   * Ensure the model is loaded before proceeding.
   * Returns false if the model failed to load or isn't available.
   */
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
   * Compute embedding for a text string.
   * Returns a Float32Array of length DIMENSION, or null if model unavailable.
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!(await this.ensureModel()) || !this.pipeline) return null;

    const truncated = text.slice(0, MAX_INPUT_CHARS);
    const output = await this.pipeline([truncated], {
      pooling: 'mean',
      normalize: true,
    });
    return new Float32Array(output.data.slice(0, DIMENSION));
  }

  /**
   * Queue a file for embedding with known content.
   * Updates are debounced and processed in batches.
   */
  queueUpdate(relativePath: string, content: string): void {
    this.pendingUpdates.set(relativePath, content);
    if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => this.flushUpdates(), UPDATE_DEBOUNCE_MS);
    }
  }

  /**
   * Queue a file for embedding by path (reads content from disk).
   * Used by file watchers that only have the path.
   */
  queuePath(relativePath: string, rootPath: string): void {
    const absPath = path.join(rootPath, relativePath);
    fs.promises
      .readFile(absPath, 'utf-8')
      .then((content) => this.queueUpdate(relativePath, content.slice(0, MAX_INPUT_CHARS)))
      .catch(() => {
        // File may have been deleted or be unreadable — skip
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
    if (!(await this.ensureModel())) return;

    const batch = Array.from(this.pendingUpdates.entries()).slice(0, BATCH_SIZE);
    for (const [relPath] of batch) {
      this.pendingUpdates.delete(relPath);
    }

    // Process each file
    for (const [relPath, content] of batch) {
      const hash = this.contentHash(content);

      // Skip if already embedded with same hash
      const existing = this.meta.entries[relPath];
      if (existing && existing.hash === hash) continue;

      const input = `${relPath}\n${content.slice(0, MAX_INPUT_CHARS)}`;
      const vector = await this.embed(input);
      if (!vector) continue;

      this.storeVector(relPath, vector, hash);
    }

    // If there are more pending, schedule another batch
    if (this.pendingUpdates.size > 0) {
      this.updateTimer = setTimeout(() => this.flushUpdates(), UPDATE_DEBOUNCE_MS);
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
      console.log(`[SideCar] Embedding index persisted: ${this.meta.count} vectors`);
    } catch (err) {
      console.warn('[SideCar] Failed to persist embedding index:', err);
    }
  }

  private async restoreCache(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;

    try {
      const meta = await this.sidecarDir.readJson<EmbeddingMeta>(META_FILE);
      if (!meta) return;

      if (meta.version !== 1 || meta.modelId !== MODEL_ID || meta.dimension !== DIMENSION) {
        console.log('[SideCar] Embedding cache version/model mismatch, rebuilding');
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
        console.warn('[SideCar] Embedding binary too small, rebuilding');
        return;
      }

      this.vectors = new Float32Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, meta.count * DIMENSION);
      this.meta = meta;
      console.log(`[SideCar] Embedding cache restored: ${meta.count} vectors`);
    } catch (err) {
      console.warn('[SideCar] Failed to restore embedding cache:', err);
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

/**
 * Cosine similarity between two unit vectors.
 * Since vectors are normalized during embedding, this is just the dot product.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
