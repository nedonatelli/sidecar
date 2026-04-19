import type { getConfig } from '../../config/settings.js';
import type { AgentCallbacks } from '../loop.js';
import { CHARS_PER_TOKEN } from '../../config/constants.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Per-iteration notification helpers for runAgentLoop.
//
// Three small functions that together own the "tell observers
// what's happening this iteration" ceremony that used to sit inline
// in the main loop body:
//
//   1. `notifyIterationStart` — emit `onIterationStart` with the
//      iteration counter, elapsed time, estimated tokens, message
//      count, remaining message budget, and at-capacity flag. The
//      chat webview uses this to render the agent-progress bar.
//
//   2. `maybeEmitProgressSummary` — every 5 iterations (starting
//      at iteration 5) emit a one-line progress summary via
//      `onProgressSummary`. Deliberately rate-limited so long runs
//      don't spam the chat.
//
//   3. `maybeCheckpointAndWait` — at 60% of max iterations, ask
//      the user via `onCheckpoint` whether to continue. Returns
//      `true` when the user stopped the run (caller should break
//      the loop). Returns `false` otherwise (including when there's
//      no checkpoint callback, we're not at the boundary, or the
//      user approved continuation).
//
// All three helpers read from `state` and compute estimated tokens
// + elapsed time internally, so the caller doesn't have to thread
// those values through.
// ---------------------------------------------------------------------------

/**
 * Emit the per-iteration telemetry event. Fires `onIterationStart`
 * with the full info payload the chat webview's agent-progress bar
 * expects. No-op when `callbacks.onIterationStart` is undefined.
 */
export function notifyIterationStart(
  state: LoopState,
  config: ReturnType<typeof getConfig>,
  callbacks: AgentCallbacks,
): void {
  const estimatedTokens = Math.ceil(state.totalChars / CHARS_PER_TOKEN);
  const messageCeiling = config.agentMaxMessages;
  const messageCount = state.messages.length;
  const messagesRemaining = Math.max(0, messageCeiling - messageCount);
  const atCapacity = messageCount >= messageCeiling;

  callbacks.onIterationStart?.({
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    elapsedMs: Date.now() - state.startTime,
    estimatedTokens,
    messageCount,
    messagesRemaining,
    atCapacity,
  });
}

/**
 * Emit a one-line progress summary every 5 iterations (starting at
 * iteration 5). Quiet on the first few turns so short runs don't
 * get polluted with "0% context used" messages, and rate-limited
 * so long runs don't spam the chat with an update per turn.
 */
export function maybeEmitProgressSummary(state: LoopState, callbacks: AgentCallbacks): void {
  if (state.iteration <= 1 || state.iteration % 5 !== 0) return;
  if (!callbacks.onProgressSummary) return;

  const estimatedTokens = Math.ceil(state.totalChars / CHARS_PER_TOKEN);
  const elapsed = Math.round((Date.now() - state.startTime) / 1000);
  const pctTokens = Math.round((estimatedTokens / state.maxTokens) * 100);
  callbacks.onProgressSummary(
    `Iteration ${state.iteration}/${state.maxIterations} · ${elapsed}s elapsed · ${pctTokens}% context used · ${state.messages.length} messages`,
  );
}

/**
 * At the 60%-of-max-iterations boundary, ask the user whether to
 * continue. Returns `true` when the user stopped the run (caller
 * should break the loop after emitting a "Stopped at checkpoint"
 * text message). Returns `false` in all other cases including when
 * there's no checkpoint callback, when we're not at the boundary,
 * or when the user approved continuation.
 *
 * The 60% threshold and the "iteration > 3" minimum mirror the
 * original inline check — short runs don't trigger the checkpoint
 * since it would fire almost immediately.
 */
export async function shouldStopAtCheckpoint(state: LoopState, callbacks: AgentCallbacks): Promise<boolean> {
  if (!callbacks.onCheckpoint) return false;
  if (state.iteration !== Math.ceil(state.maxIterations * 0.6)) return false;
  if (state.iteration <= 3) return false;

  const estimatedTokens = Math.ceil(state.totalChars / CHARS_PER_TOKEN);
  const pctTokens = Math.round((estimatedTokens / state.maxTokens) * 100);
  const shouldContinue = await callbacks.onCheckpoint(
    `Reached iteration ${state.iteration} of ${state.maxIterations}. ${pctTokens}% context used.`,
    state.iteration,
    state.maxIterations - state.iteration,
  );

  if (!shouldContinue) {
    state.logger?.info('User stopped at checkpoint');
    callbacks.onText('\n\nStopped at checkpoint.');
    return true;
  }
  return false;
}
