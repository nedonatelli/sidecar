/**
 * Model-specific agent behavior overrides derived from eval harness results.
 *
 * Cold-start models: some models (e.g. gemma4:e4b) switch from tool-use mode to
 * chat-response mode when given prior conversation context (setupMessages, history
 * injections). For these models the agent loop must be started fresh — no setupMessages,
 * no prepended conversation history — so the first message the model sees is the raw
 * task prompt. Counter-intuitively, skipping the warm-up context improves tool-use
 * pass rates for these models.
 */

/**
 * The recommended default local model based on eval results (2026-06-01).
 *
 * ministral-3:latest — 6 GB, 94% agent eval pass rate (best local agent score).
 * Passes multi-file, multi-step tasks reliably; used ministral-3 to produce a
 * correct fix to SideCar's own cycle-detector stop messages in the dev-loop test.
 *
 * Alternatives by use-case:
 *   granite4.1:3b  — 2 GB, 81% (best size/performance ratio, low-RAM machines)
 *   qwen3.5:latest — 6.6 GB, 69% (decent but less reliable on complex tasks)
 *   gemma4:e4b     — 9.6 GB, 68% (needs cold-start, see MODELS_NEEDING_COLD_START)
 */
export const RECOMMENDED_LOCAL_MODEL = 'ministral-3:latest';

/**
 * Models (or model prefixes) that perform worse when given prior conversation context.
 * The agent harness should skip setupMessages and history injection for these models.
 */
export const MODELS_NEEDING_COLD_START: readonly string[] = ['gemma4:e4b'] as const;

/**
 * Models where thinking/extended-reasoning mode interferes with tool-use reliability.
 * Thinking tokens cause these models to stall, time out, or fail to emit tool calls.
 */
export const MODELS_WITH_PROBLEMATIC_THINKING: readonly string[] = [
  'qwen3:8b',
  'qwen3:14b',
  'qwen3:32b',
  'glm-4.7-flash:latest',
  'laguna-xs.2:latest',
] as const;

/**
 * Returns true if the given model should be cold-started (no prior context injected).
 * Matches exact model IDs and the gemma4 variant prefix pattern.
 */
export function needsColdStart(model: string): boolean {
  if (MODELS_NEEDING_COLD_START.includes(model)) {
    return true;
  }
  // Match any gemma4 variant (e.g. gemma4:27b, gemma4:12b, gemma4:e4b, gemma4-it:latest)
  if (/^gemma4[:/]/.test(model)) {
    return true;
  }
  return false;
}

/**
 * Returns true if the given model has known issues when thinking mode is enabled.
 * Thinking mode should be suppressed for these models in the agent loop.
 */
export function hasProblematicThinking(model: string): boolean {
  if (MODELS_WITH_PROBLEMATIC_THINKING.includes(model)) {
    return true;
  }
  // Match any qwen3 variant with a size suffix that has known thinking-mode issues
  if (/^qwen3:(8b|14b|32b)$/i.test(model)) {
    return true;
  }
  return false;
}
