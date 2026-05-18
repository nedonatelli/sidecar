// ---------------------------------------------------------------------------
// In-process Whisper transcription via @huggingface/transformers.
//
// Accepts a Buffer of little-endian float32 PCM samples at 16 kHz (mono).
// The recording page decodes and resamples the browser audio to this format
// before POSTing, so no server-side audio decoding is needed.
//
// The pipeline is lazy-loaded and cached for the extension host lifetime.
// Same lazy-init pattern as SymbolEmbeddingIndex.loadModel().
// ---------------------------------------------------------------------------

type AsrPipeline = (input: { data: Float32Array; sampling_rate: number }) => Promise<{ text: string }>;

let _pipeline: AsrPipeline | null = null;
let _modelLoading: Promise<void> | null = null;
let _loadedModel: string | null = null;

async function loadModel(model: string): Promise<void> {
  const { pipeline: createPipeline, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = true;
  _pipeline = (await createPipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
  })) as unknown as AsrPipeline;
  _loadedModel = model;
}

async function ensurePipeline(model: string): Promise<boolean> {
  if (_pipeline && _loadedModel === model) return true;
  // Model changed — evict.
  if (_loadedModel !== model) {
    _pipeline = null;
    _modelLoading = null;
    _loadedModel = null;
  }
  if (_modelLoading) {
    try {
      await _modelLoading;
      return _pipeline !== null;
    } catch {
      return false;
    }
  }
  _modelLoading = loadModel(model).finally(() => {
    _modelLoading = null;
  });
  try {
    await _modelLoading;
    return _pipeline !== null;
  } catch {
    return false;
  }
}

export async function transcribeLocally(pcmBuffer: Buffer, model: string): Promise<string> {
  const ready = await ensurePipeline(model);
  if (!ready || !_pipeline) {
    throw new Error(`Failed to load local Whisper model "${model}".`);
  }
  const ab = pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength) as ArrayBuffer;
  const float32 = new Float32Array(ab);
  const result = await _pipeline({ data: float32, sampling_rate: 16_000 });
  return result.text.trim();
}

/** True when the model id looks like a HuggingFace hub path (e.g. Xenova/whisper-tiny). */
export function isLocalModel(model: string): boolean {
  return model.includes('/');
}

/** True when the pipeline is already loaded for the given model (no download needed). */
export function isModelLoaded(model: string): boolean {
  return _pipeline !== null && _loadedModel === model;
}

/** Test-only: inject a pre-built pipeline and skip model loading. */
export function _setPipelineForTests(p: AsrPipeline | null, model = '__test__'): void {
  _pipeline = p;
  _loadedModel = p ? model : null;
  _modelLoading = null;
}
