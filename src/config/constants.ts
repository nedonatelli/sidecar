// ---------------------------------------------------------------------------
// Centralized constants for tunable thresholds and magic numbers.
// Keeping these in one place makes it easy to adjust behavior and
// ensures consistency across the codebase.
// ---------------------------------------------------------------------------

/** Token estimation: approximate characters per token for LLM tokenizers. */
export const CHARS_PER_TOKEN = 4;

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

/**
 * Context budget: fraction of estimated context window to reserve for the system prompt.
 * The remaining budget is for conversation history + tool results.
 */
export const SYSTEM_PROMPT_BUDGET_FRACTION = 0.5;

/** Fallback max system prompt characters when model context length is unknown. */
export const DEFAULT_MAX_SYSTEM_CHARS = 80_000;

/**
 * Soft cap on how much context SideCar will pack into a single local-model
 * request. Very large prompts cause extreme first-token latency on consumer
 * hardware regardless of the model's native context window size.
 *
 * Must be kept in sync with the num_ctx floor in OllamaBackend.streamChat
 * (currently 32 768). Setting this below that floor causes the budget
 * calculations to use a smaller window than Ollama actually allocates,
 * which makes the verbose context report misleading and under-uses the KV
 * cache we already paid for.
 */
export const LOCAL_CONTEXT_CAP = 32_768;

/**
 * Plan mode auto-detection thresholds.
 * Messages exceeding these are treated as complex multi-step tasks.
 */
export const PLAN_MODE_THRESHOLDS = {
  WORD_COUNT: 400,
  CHAR_COUNT: 2500,
};

/** Relevance scoring for workspace file context. */
export const RELEVANCE = {
  /** Default decay factor per conversation turn (0.8 = 20% decay). */
  DECAY_FACTOR: 0.8,
};

/** Tool support detection: how many runtime failures before disabling tools. */
export const TOOL_FAILURE_THRESHOLD = 3;

/** Max concurrent background shell commands to prevent resource exhaustion. */
export const MAX_BACKGROUND_COMMANDS = 10;

/** Tool capability probe: max models to query in parallel. */
export const MODEL_PROBE_BATCH_SIZE = 15;

// ---------------------------------------------------------------------------
// Well-known model context lengths (tokens)
// ---------------------------------------------------------------------------
// Cloud providers don't always expose context length via API. This lookup
// table provides accurate values for popular models. Used by
// `getModelContextLength()` when the provider can't be queried dynamically.
// ---------------------------------------------------------------------------

export const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
  // Anthropic Claude models — 200K context
  'claude-opus-4-5': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5': 200_000,
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
