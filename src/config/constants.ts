// ---------------------------------------------------------------------------
// Centralized constants for tunable thresholds and magic numbers.
// Keeping these in one place makes it easy to adjust behavior and
// ensures consistency across the codebase.
// ---------------------------------------------------------------------------

/**
 * Cost estimation ratio: for a completed agent run where we only know the
 * total token count (not the input/output split), approximate the split as
 * 70/30. This matches the observed ratio in mixed chat + tool-use runs
 * where prompt context dominates over generated output. Used by
 * `chatHandlers` when recording per-run cost.
 */
export const INPUT_TOKEN_RATIO = 0.7;

/**
 * Agent loop context-compression trigger: when estimated tokens exceed this
 * fraction of the budget, the loop runs summarization + tool-result
 * compression to reclaim space before the next turn. Sized so compression
 * runs early enough to leave headroom for the model's next response while
 * still amortizing the cost across multiple turns.
 */
export const CONTEXT_COMPRESSION_THRESHOLD = 0.7;

/** Fallback max system prompt characters when model context length is unknown. */
export const DEFAULT_MAX_SYSTEM_CHARS = 80_000;

/**
 * Hard cap on system prompt characters for local Ollama models, regardless
 * of the model's native context window. Raising LOCAL_CONTEXT_CAP to 128K
 * would otherwise scale the 40% system-prompt budget to ~204K chars (~51K
 * tokens) — too much for small models (4B–12B params) to attend through
 * reliably. At 51K system tokens the model often produces text-only
 * responses instead of tool calls, causing the agent loop to exit after one
 * iteration. 52K chars (~13K tokens) matches pre-v0.112 behavior and keeps
 * injected file/symbol context at a level small models can handle.
 */
export const LOCAL_MAX_SYSTEM_CHARS = 52_000;

/**
 * Soft cap on the context window SideCar will request from a local model.
 * Set to 128 K to match the native window of the default Ollama model
 * (gemma4:e4b, 128 K). The probed `num_ctx` from Ollama's /api/show is
 * clamped to this ceiling so models that advertise an impossibly large
 * context don't allocate a KV cache that OOMs the machine.
 *
 * Users on machines with limited VRAM (< 8 GB) who run larger models
 * (30 B+) should set `sidecar.ollama.numCtx` explicitly to a smaller value
 * (e.g. 32 768) to avoid latency from a large KV cache allocation.
 */
export const LOCAL_CONTEXT_CAP = 131_072;

/**
 * Per-model context caps that override LOCAL_CONTEXT_CAP downward. KV-cache
 * cost at a given window varies enormously by architecture: gemma4:e4b uses
 * interleaved local attention and holds 131 K affordably (~12 GB total), but
 * llama3.2 attends globally on every layer — at 131 K a "2 GB" model
 * allocated a 17.4 GB llama-server (observed live; it took the host machine
 * down). 64 K keeps llama3.2's KV within reason while leaving generous room
 * for agent workloads. `sidecar.ollama.numCtx` still overrides everything.
 */
export const LOCAL_MODEL_CONTEXT_CAPS: ReadonlyArray<{ pattern: RegExp; cap: number }> = [
  { pattern: /^llama3\.2/i, cap: 65_536 },
];

/** The context ceiling for a local model: its per-model cap, else LOCAL_CONTEXT_CAP. */
export function contextCapForModel(model: string): number {
  for (const { pattern, cap } of LOCAL_MODEL_CONTEXT_CAPS) {
    if (pattern.test(model)) return cap;
  }
  return LOCAL_CONTEXT_CAP;
}

/**
 * Plan mode auto-detection thresholds.
 * Messages exceeding these are treated as complex multi-step tasks.
 */
export const PLAN_MODE_THRESHOLDS = {
  WORD_COUNT: 400,
  CHAR_COUNT: 2500,
};

/** Tool support detection: how many runtime failures before disabling tools. */
export const TOOL_FAILURE_THRESHOLD = 3;

/** Max concurrent background shell commands to prevent resource exhaustion. */
export const MAX_BACKGROUND_COMMANDS = 10;

/** Tool capability probe: max models to query in parallel. */
export const MODEL_PROBE_BATCH_SIZE = 15;

// ---------------------------------------------------------------------------
// Speculative decoding — curated draft-model pairs
// ---------------------------------------------------------------------------
// Each pair shares the same tokenizer vocabulary so acceptance rates stay
// high. The main model generates the authoritative result; the draft model
// races it and wins when it finishes first (typical for short completions).
// Keys use the canonical Ollama/Kickstand model-id prefix without quant
// suffix so lookupDraftModel() can match tagged variants like
// `qwen2.5-coder:32b-instruct-q4_k_m`.
// ---------------------------------------------------------------------------

export const DRAFT_MODEL_MAP: Record<string, string> = {
  'qwen3-coder:30b': 'qwen2.5-coder:0.5b',
  'qwen3-coder:14b': 'qwen2.5-coder:0.5b',
  'qwen2.5-coder:32b': 'qwen2.5-coder:0.5b',
  'qwen2.5-coder:14b': 'qwen2.5-coder:0.5b',
  'qwen2.5-coder:7b': 'qwen2.5-coder:0.5b',
  'qwen3:30b': 'qwen3:1.7b',
  'qwen3:14b': 'qwen3:1.7b',
  'qwen3:8b': 'qwen3:1.7b',
  'deepseek-coder:33b': 'deepseek-coder:1.3b-base',
  'deepseek-coder-v2:16b': 'deepseek-coder:1.3b-base',
  'codellama:34b': 'codellama:7b-code',
  'codellama:13b': 'codellama:7b-code',
};

/**
 * Return the recommended draft model for a given main model id, or
 * undefined when no curated pair exists. Checks for exact match first,
 * then falls back to prefix matching so variants like
 * `qwen2.5-coder:32b-instruct-q4_k_m` resolve to the `qwen2.5-coder:32b`
 * entry.
 */
export function lookupDraftModel(mainModel: string): string | undefined {
  if (DRAFT_MODEL_MAP[mainModel]) return DRAFT_MODEL_MAP[mainModel];
  for (const [key, draft] of Object.entries(DRAFT_MODEL_MAP)) {
    if (mainModel.startsWith(key + '-') || mainModel.startsWith(key + '_')) {
      return draft;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Well-known model context lengths (tokens)
// ---------------------------------------------------------------------------
// Cloud providers don't always expose context length via API. This lookup
// table provides accurate values for popular models. Used by
// `getModelContextLength()` when the provider can't be queried dynamically.
// ---------------------------------------------------------------------------

export const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
  // Anthropic Claude models — 200K context
  'claude-opus-4-7': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4-7': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-3-7-sonnet-latest': 200_000,
  'claude-3-5-sonnet-latest': 200_000,
  'claude-3-5-haiku-latest': 200_000,
  'claude-3-opus-latest': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,

  // OpenAI GPT-4 models
  'gpt-4o': 128_000,
  'gpt-4o-2024-11-20': 128_000,
  'gpt-4o-2024-08-06': 128_000,
  'gpt-4o-2024-05-13': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4o-mini-2024-07-18': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4-turbo-2024-04-09': 128_000,
  'gpt-4-turbo-preview': 128_000,
  'gpt-4-0125-preview': 128_000,
  'gpt-4-1106-preview': 128_000,
  'gpt-4': 8_192,
  'gpt-4-0613': 8_192,
  'gpt-4-32k': 32_768,
  'gpt-4-32k-0613': 32_768,

  // OpenAI GPT-3.5 models
  'gpt-3.5-turbo': 16_385,
  'gpt-3.5-turbo-0125': 16_385,
  'gpt-3.5-turbo-1106': 16_385,
  'gpt-3.5-turbo-16k': 16_385,

  // OpenAI o1/o3 reasoning models
  o1: 200_000,
  'o1-2024-12-17': 200_000,
  'o1-preview': 128_000,
  'o1-preview-2024-09-12': 128_000,
  'o1-mini': 128_000,
  'o1-mini-2024-09-12': 128_000,
  'o3-mini': 200_000,
  'o3-mini-2025-01-31': 200_000,

  // Groq models (context limits as of Jan 2025)
  'llama-3.3-70b-versatile': 128_000,
  'llama-3.1-70b-versatile': 128_000,
  'llama-3.1-8b-instant': 128_000,
  'llama3-70b-8192': 8_192,
  'llama3-8b-8192': 8_192,
  'mixtral-8x7b-32768': 32_768,
  'gemma2-9b-it': 8_192,

  // Google Gemini models (via OpenAI-compatible or OpenRouter)
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-pro-latest': 2_097_152,
  'gemini-1.5-flash': 1_048_576,
  'gemini-1.5-flash-latest': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-exp': 1_048_576,
  'gemini-pro': 32_768,

  // Mistral models
  'mistral-large-latest': 128_000,
  'mistral-large-2411': 128_000,
  'mistral-medium-latest': 32_000,
  'mistral-small-latest': 32_000,
  'codestral-latest': 32_000,
  'open-mistral-nemo': 128_000,
  'open-mixtral-8x22b': 65_536,
  'open-mixtral-8x7b': 32_768,

  // DeepSeek models
  'deepseek-chat': 64_000,
  'deepseek-coder': 64_000,
  'deepseek-reasoner': 64_000,

  // Fireworks models (common ones)
  'accounts/fireworks/models/llama-v3p1-70b-instruct': 131_072,
  'accounts/fireworks/models/llama-v3p1-8b-instruct': 131_072,
  'accounts/fireworks/models/mixtral-8x7b-instruct': 32_768,
  'accounts/fireworks/models/qwen2p5-coder-32b-instruct': 32_768,
};
