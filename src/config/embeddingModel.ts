/**
 * Loading the embedding model, with no dependency on `vscode` or the logger,
 * so the embedding worker thread (embeddingWorker.ts) can import it.
 */

/** MiniLM-L6-v2 (384-dim), used for every SideCar feature-extraction task. */
export const MINILM_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/** Default embedding width for MiniLM-L6-v2. */
export const MINILM_DIMENSION = 384;

/**
 * Typed calling convention for a loaded feature-extraction pipeline.
 * @huggingface/transformers' `pipeline()` factory returns the base
 * `Pipeline` class — this type + the cast in `loadInThreadPipeline`
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
 * Load the feature-extraction pipeline with q8 quantization on the calling
 * thread. All env mutation and the `as unknown as EmbeddingPipeline` cast
 * live here and nowhere else.
 */
export async function loadInThreadPipeline(
  modelId: string,
  envOpts: EmbeddingPipelineEnvOpts = {},
): Promise<EmbeddingPipeline> {
  const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
  if (envOpts.cacheDir !== undefined) env.cacheDir = envOpts.cacheDir;
  if (envOpts.allowLocalModels !== undefined) env.allowLocalModels = envOpts.allowLocalModels;
  if (envOpts.allowRemoteModels !== undefined) env.allowRemoteModels = envOpts.allowRemoteModels;
  return (await createPipeline('feature-extraction', modelId, { dtype: 'q8' })) as unknown as EmbeddingPipeline;
}

/** Main thread → worker. */
export interface EmbedRequest {
  id: number;
  texts: string[];
  opts?: { pooling?: string; normalize?: boolean };
}

/** Worker → main thread: the model loaded, or failed to. */
export type WorkerStatus = { type: 'ready' } | { type: 'load-failed'; message: string };

/** Worker → main thread: one embed's result. */
export type EmbedResponse = { id: number; data: Float32Array } | { id: number; error: string };

/** What the worker is started with. */
export interface WorkerInit {
  modelId: string;
  envOpts: EmbeddingPipelineEnvOpts;
}
