/**
 * MiniLM-L6-v2 (384-dim) used for all SideCar feature-extraction tasks.
 * Single source of truth for the model ID so cache-key validation in
 * every embedding store stays in sync.
 */
export const MINILM_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

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
