import { logger } from '../system/logger.js';

/**
 * MiniLM-L6-v2 (384-dim) used for all SideCar feature-extraction tasks.
 * Single source of truth for the model ID so cache-key validation in
 * every embedding store stays in sync.
 */
export const MINILM_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/** Default embedding width for MiniLM-L6-v2. */
export const MINILM_DIMENSION = 384;

/**
 * Typed calling convention for a loaded feature-extraction pipeline.
 * @huggingface/transformers' `pipeline()` factory returns the base
 * `Pipeline` class — this type + the cast in `loadEmbeddingPipeline`
 * below are the single place we bridge to the concrete signature.
 */
export type EmbeddingPipeline = (
  texts: string[],
  opts?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

export interface EmbeddingPipelineEnvOpts {
  cacheDir?: string;
  allowLocalModels?: boolean;
  allowRemoteModels?: boolean;
}

/**
 * Load the feature-extraction pipeline with q8 quantization.
 * The caller supplies per-site env options; all env mutation and the
 * `as unknown as EmbeddingPipeline` cast live here and nowhere else.
 */
export async function loadEmbeddingPipeline(
  modelId: string,
  envOpts: EmbeddingPipelineEnvOpts = {},
): Promise<EmbeddingPipeline> {
  const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
  if (envOpts.cacheDir !== undefined) env.cacheDir = envOpts.cacheDir;
  if (envOpts.allowLocalModels !== undefined) env.allowLocalModels = envOpts.allowLocalModels;
  if (envOpts.allowRemoteModels !== undefined) env.allowRemoteModels = envOpts.allowRemoteModels;
  return (await createPipeline('feature-extraction', modelId, { dtype: 'q8' })) as unknown as EmbeddingPipeline;
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
// rule is retry-allowed: a transient load failure nulls the in-flight promise
// so the next call re-attempts (EmbeddingIndex previously cached the rejected
// promise and stayed disabled for the whole session).
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

export class LazyEmbedder {
  private pipeline: EmbeddingPipeline | null = null;
  private loading: Promise<boolean> | null = null;

  constructor(private readonly opts: LazyEmbedderOpts) {}

  /** True once the model is loaded and ready to embed. */
  get ready(): boolean {
    return this.pipeline !== null;
  }

  /** Kick off loading in the background. Safe to call repeatedly. */
  start(): void {
    void this.ensureReady();
  }

  /** Load the model if needed. Returns false (not throwing) when unavailable. */
  async ensureReady(): Promise<boolean> {
    if (this.pipeline) return true;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        this.pipeline = await getSharedPipeline(this.opts.modelId ?? MINILM_MODEL_ID, this.opts.envOpts?.() ?? {});
        logger.info(`[${this.opts.label}] Embedding model loaded`);
        return true;
      } catch (err) {
        logger.warn(`[${this.opts.label}] Embedding model failed to load:`, err instanceof Error ? err.message : err);
        this.loading = null; // retry-allowed: let the next call re-attempt
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
