import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { logger } from '../system/logger.js';
import {
  loadInThreadPipeline,
  MINILM_DIMENSION,
  MINILM_MODEL_ID,
  type EmbeddingPipeline,
  type EmbeddingPipelineEnvOpts,
  type EmbedRequest,
  type EmbedResponse,
  type WorkerInit,
  type WorkerStatus,
} from './embeddingModel.js';

export { MINILM_MODEL_ID, MINILM_DIMENSION };
export type { EmbeddingPipeline, EmbeddingPipelineEnvOpts };

/** The bundled worker sits next to dist/extension.js; running from source there is none. */
function workerScript(): string | null {
  if (typeof __dirname !== 'string') return null;
  const file = path.join(__dirname, 'embeddingWorker.js');
  return existsSync(file) ? file : null;
}

/**
 * Load the feature-extraction pipeline (MiniLM, q8). In the packaged
 * extension it runs in a worker thread (#399): onnxruntime-node runs each
 * inference synchronously on its calling thread, and the extension host's
 * thread is shared by every extension in the window. Without the bundled
 * worker (running from source) it loads on the calling thread.
 */
export async function loadEmbeddingPipeline(
  modelId: string,
  envOpts: EmbeddingPipelineEnvOpts = {},
): Promise<EmbeddingPipeline> {
  const script = workerScript();
  return script ? loadWorkerPipeline(script, modelId, envOpts) : loadInThreadPipeline(modelId, envOpts);
}

/** Exported for tests, which pass a stub worker script and a stub `inThread`. */
export async function loadWorkerPipeline(
  script: string,
  modelId: string,
  envOpts: EmbeddingPipelineEnvOpts,
  inThread: typeof loadInThreadPipeline = loadInThreadPipeline,
): Promise<EmbeddingPipeline> {
  const worker = new Worker(script, { workerData: { modelId, envOpts } satisfies WorkerInit });
  // An idle worker must not hold the extension host open on shutdown.
  worker.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      const onMessage = (msg: WorkerStatus) => {
        cleanup();
        if (msg.type === 'ready') resolve();
        else reject(new Error(msg.message));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number) => {
        cleanup();
        reject(new Error(`embedding worker exited (code ${code}) before the model loaded`));
      };
      const cleanup = () => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
    });
  } catch (err) {
    await worker.terminate();
    throw err;
  }
  logger.info(`[SideCar] Embedding model ${modelId} running in a worker thread`);

  const pending = new Map<number, { resolve: (out: { data: Float32Array }) => void; reject: (err: Error) => void }>();
  let nextId = 0;
  // A worker that dies mid-session falls back to this thread rather than
  // leaving every later embed to fail: slower for the host, but not silent.
  let fallback: Promise<EmbeddingPipeline> | null = null;
  const stopped = (reason: string) => {
    if (fallback) return;
    logger.warn(`[SideCar] Embedding worker stopped (${reason}); embedding on the extension host thread from now on`);
    fallback = inThread(modelId, envOpts);
    for (const p of pending.values()) p.reject(new Error(`embedding worker stopped: ${reason}`));
    pending.clear();
  };
  worker.on('message', (msg: EmbedResponse) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if ('error' in msg) p.reject(new Error(msg.error));
    else p.resolve({ data: msg.data });
  });
  worker.on('error', (err) => stopped(err.message));
  worker.on('exit', (code) => stopped(`exit code ${code}`));

  return async (texts, opts) => {
    if (fallback) return (await fallback)(texts, opts);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, texts, opts } satisfies EmbedRequest);
    });
  };
}

/**
 * Singleton cache keyed by model ID. All indices that use the same model
 * (EmbeddingIndex, SymbolEmbeddingIndex, SidecarMdIndex) share the same
 * loaded pipeline instance instead of each paying the 3-8s cold-start cost.
 * The first caller's envOpts win; subsequent callers get the cached promise.
 */
const _pipelineCache = new Map<string, Promise<EmbeddingPipeline>>();

export function getSharedPipeline(modelId: string, envOpts: EmbeddingPipelineEnvOpts = {}): Promise<EmbeddingPipeline> {
  if (!_pipelineCache.has(modelId)) {
    const promise = (_loaderForTests ?? loadEmbeddingPipeline)(modelId, envOpts);
    _pipelineCache.set(modelId, promise);
    // Evict on failure so the next caller gets a fresh load attempt.
    promise.catch(() => _pipelineCache.delete(modelId));
  }
  return _pipelineCache.get(modelId)!;
}

// ---------------------------------------------------------------------------
// Test injection — allows unit tests to substitute a controlled loader
// without going through the real @huggingface/transformers dynamic import.
// Call with null to restore the default loader.
// ---------------------------------------------------------------------------
type PipelineLoader = (modelId: string, envOpts?: EmbeddingPipelineEnvOpts) => Promise<EmbeddingPipeline>;
let _loaderForTests: PipelineLoader | null = null;

export function setLoaderForTests(loader: PipelineLoader | null): void {
  _loaderForTests = loader;
  _pipelineCache.clear();
}

// ---------------------------------------------------------------------------
// LazyEmbedder — shared model-lifecycle owner for every embedding store.
//
// Consolidates the load-once / retry-on-failure / embed logic that was copy
// pasted (with divergent retry semantics) into EmbeddingIndex,
// SymbolEmbeddingIndex, EpisodicMemoryStore, and SidecarMdIndex. The unified
// rule is bounded retry: a failed load is re-attempted after each delay in
// MODEL_LOAD_RETRY_DELAYS_MS, then not until retryModelLoad() (EmbeddingIndex
// once cached the rejected promise and stayed disabled for the whole session;
// the later retry-allowed rule re-attempted on every call, without limit).
//
// Supports both consumption styles: lazy-first-use (call `embed`/`ensureReady`)
// and eager-background-start (call `start()` in the owner's constructor).
// ---------------------------------------------------------------------------

export interface LazyEmbedderOpts {
  /** Log-prefix label, e.g. 'EmbeddingIndex'. */
  label: string;
  modelId?: string;
  /** Embedding width; output is sliced to this. Default MINILM_DIMENSION. */
  dimension?: number;
  /** Truncate input text to this many chars before embedding. Default: no truncation. */
  maxChars?: number;
  /** Per-site env options, evaluated at load time (cacheDir may depend on runtime state). */
  envOpts?: () => EmbeddingPipelineEnvOpts;
}

/**
 * Wait before each retry of a failed model load. After the last one fails,
 * loading stops until `retryModelLoad()` (#401): offline on a first run, or
 * with a corrupt cache, the symbol index used to re-attempt the whole load
 * every 250 ms, with a warning each time, for as long as the window was open.
 */
export const MODEL_LOAD_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

export class LazyEmbedder {
  private pipeline: EmbeddingPipeline | null = null;
  private loading: Promise<boolean> | null = null;
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(private readonly opts: LazyEmbedderOpts) {}

  /** True once the model is loaded and ready to embed. */
  get ready(): boolean {
    return this.pipeline !== null;
  }

  /** True once every retry has failed: nothing loads until `retryModelLoad()`. */
  get gaveUp(): boolean {
    return this.failures > MODEL_LOAD_RETRY_DELAYS_MS.length;
  }

  /** Milliseconds until a load may be attempted again; 0 when one may start now. */
  msUntilNextAttempt(): number {
    return Math.max(0, this.nextAttemptAt - Date.now());
  }

  /** Forget past failures, so the next `ensureReady` attempts a load (an explicit user retry). */
  retryModelLoad(): void {
    this.failures = 0;
    this.nextAttemptAt = 0;
  }

  /** Kick off loading in the background. Safe to call repeatedly. */
  start(): void {
    void this.ensureReady();
  }

  /**
   * Load the model if needed. Returns false (not throwing) when unavailable:
   * immediately, without a new attempt, while a retry delay is pending or
   * after every retry has failed.
   */
  async ensureReady(): Promise<boolean> {
    if (this.pipeline) return true;
    if (this.loading) return this.loading;
    if (this.gaveUp || this.msUntilNextAttempt() > 0) return false;
    this.loading = (async () => {
      try {
        this.pipeline = await getSharedPipeline(this.opts.modelId ?? MINILM_MODEL_ID, this.opts.envOpts?.() ?? {});
        logger.info(`[${this.opts.label}] Embedding model loaded`);
        return true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.failures += 1;
        const delay = MODEL_LOAD_RETRY_DELAYS_MS[this.failures - 1];
        if (delay === undefined) {
          logger.warn(
            `[${this.opts.label}] Embedding model failed to load ${this.failures} times (${reason}); not retrying. ` +
              `Its semantic search is off until the window is reloaded.`,
          );
        } else {
          this.nextAttemptAt = Date.now() + delay;
          logger.warn(`[${this.opts.label}] Embedding model failed to load (${reason}); retrying in ${delay / 1000} s`);
        }
        this.loading = null;
        return false;
      }
    })();
    return this.loading;
  }

  /** Query embeds in flight — batch embeds yield to these between items. */
  private pendingPriority = 0;
  private priorityWaiters: Array<() => void> = [];

  /**
   * Embed one string, or null when the model is unavailable / the call fails.
   *
   * `priority: true` marks a latency-sensitive embed (a RETRIEVAL QUERY): it
   * runs immediately, and non-priority (batch/index) embeds started while any
   * priority embed is pending wait until the priority lane clears. Without
   * this, the first prompt after a churn-heavy reload queued its query embed
   * behind a ~6,000-symbol PKI replay on the shared single-threaded pipeline —
   * measured live: a 157-second "Building context" stall (v0.119 dogfood).
   */
  async embed(text: string, opts?: { priority?: boolean }): Promise<Float32Array | null> {
    if (!(await this.ensureReady()) || !this.pipeline) return null;
    if (opts?.priority) {
      this.pendingPriority += 1;
      try {
        return await this.runEmbed(text);
      } finally {
        this.pendingPriority -= 1;
        if (this.pendingPriority === 0) {
          const waiters = this.priorityWaiters;
          this.priorityWaiters = [];
          for (const release of waiters) release();
        }
      }
    }
    while (this.pendingPriority > 0) {
      await new Promise<void>((release) => this.priorityWaiters.push(release));
    }
    return this.runEmbed(text);
  }

  private async runEmbed(text: string): Promise<Float32Array | null> {
    if (!this.pipeline) return null;
    try {
      const input = this.opts.maxChars ? text.slice(0, this.opts.maxChars) : text;
      const output = await this.pipeline([input], { pooling: 'mean', normalize: true });
      return new Float32Array(output.data.slice(0, this.opts.dimension ?? MINILM_DIMENSION));
    } catch (err) {
      // The model loaded but this specific embed call threw — surface it (a
      // caller batching many items keeps going and skips just this one).
      logger.warn(`[${this.opts.label}] embed failed:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Test-only: inject a pre-built pipeline, or null to pin the embedder as
   * permanently unavailable (a resolved-false load, so `embed` returns null
   * without touching the real model loader).
   */
  setPipelineForTests(pipeline: EmbeddingPipeline | null): void {
    this.pipeline = pipeline;
    this.loading = Promise.resolve(pipeline !== null);
  }
}
