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
 * Context budget: fraction of estimated context window to reserve for the system prompt.
 * The remaining budget is for conversation history + tool results.
 */
export const SYSTEM_PROMPT_BUDGET_FRACTION = 0.5;

/** Fallback max system prompt characters when model context length is unknown. */
export const DEFAULT_MAX_SYSTEM_CHARS = 80_000;

/**
 * Local model context cap. Many local models advertise huge context windows
 * (e.g. 262K) but Ollama's default num_ctx is much smaller, and large prompts
 * cause extreme first-token latency on local hardware.
 */
export const LOCAL_CONTEXT_CAP = 16_384;

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
