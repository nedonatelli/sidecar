import type { SideCarClient } from '../../ollama/client.js';
import { logger } from '../../system/logger.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import { getContentText } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import { parseTextToolCallsCleaned, stripRepeatedContent } from './textParsing.js';
import { renderPlanState, planStepWriteTargetsNotWritten } from '../plans/externalPlan.js';
import { ThinkingStore } from '../thinking/thinkingStore.js';
import { logApiCall } from '../apiAuditLog.js';
// getConfig removed — thinkingMode now read from state.config (injected at loop entry)

const thinkingStore = new ThinkingStore();

// ---------------------------------------------------------------------------
// Stream one turn of a runAgentLoop iteration.
//
// The inner job of each iteration is to ask the model for a response,
// collect streaming events (text, thinking, tool_use), handle timeout
// and abort cleanly, and hand back a structured turn result the
// orchestrator can reason about. Previously this was an 90-line
// nested try/finally block in the middle of runAgentLoop; factoring
// it out lets the orchestrator focus on "what to do with the turn"
// rather than the streaming mechanics.
//
// Two helpers live here:
//
//   - `streamOneTurn` does the raw streaming: opens the request,
//     races each .next() against the request timeout, accumulates
//     events, handles abort and timeout by returning a `terminated`
//     marker rather than throwing (easier to branch on in the
//     orchestrator than try/catch around the call site).
//
//   - `resolveTurnContent` does the post-stream cleanup: strips
//     paragraphs the model is echoing verbatim from earlier turns,
//     and falls back to text-level tool-call parsing for models that
//     don't emit structured tool_use blocks. Pure function, no
//     streaming side effects.
//
// Both helpers mutate `state.totalChars` and fire the usual callbacks
// (`onText`, `onThinking`, `onToolCall`, `onCharsConsumed`). The
// caller observes the turn result via the returned `TurnResult`.
// ---------------------------------------------------------------------------

/** Reason a stream ended before natural completion. */
export type TurnTermination = 'none' | 'aborted' | 'timeout';

export interface TurnResult {
  /** Concatenated text content from all text events in this turn. */
  fullText: string;
  /** Tool-use blocks the model emitted this turn. */
  pendingToolUses: ToolUseContentBlock[];
  /** Final stop_reason from the model, or the default 'end_turn' if the stream had no stop event. */
  stopReason: string;
  /** Non-`'none'` when the stream bailed early. */
  terminated: TurnTermination;
}

/**
 * Race `promise` against an AbortSignal. Rejects with a `DOMException`
 * AbortError when the signal fires before the promise settles. This is
 * needed so that hanging mock generators (used in tests) can be
 * interrupted by a timeout, in addition to real fetch generators which
 * are cancelled via the underlying AbortSignal passed to streamChat.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Query the session's episodic memory store and return a formatted
 * `<prior_context>` block to append to the system prompt, or
 * `undefined` when the store is empty or no hits clear the similarity
 * floor. The query text is derived from the last real user message in
 * the current history (tool_result messages are skipped).
 */
async function buildEpisodicAddon(client: SideCarClient, state: LoopState): Promise<string | undefined> {
  if (state.episodicMemory.isEmpty()) return undefined;

  let queryText = '';
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg.role !== 'user') continue;
    const text = typeof msg.content === 'string' ? msg.content : getContentText(msg.content);
    if (text.trim()) {
      queryText = text;
      break;
    }
  }
  if (!queryText) return undefined;

  return state.episodicMemory.buildContextBlock(queryText).catch(() => undefined);
}

function abortedPromise(signal: AbortSignal): Promise<undefined> {
  return new Promise<undefined>((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
}

/**
 * Stream the next model turn. Handles abort, request timeout, and
 * the full event-type switch (text, thinking, warning, tool_use,
 * stop). Mutates `state.totalChars` for text/thinking chunks and
 * fires `onText`, `onThinking`, `onToolCall`, and `onCharsConsumed`
 * callbacks as events arrive.
 *
 * Returns a `TurnResult` with `terminated='aborted'` or `'timeout'`
 * when the stream was cut short, instead of throwing — makes the
 * orchestrator's branching simpler (`if (turn.terminated !== 'none') break;`).
 *
 * Non-abort, non-timeout errors are re-thrown to the caller so the
 * eval harness + error surface can record them.
 */
export async function streamOneTurn(
  client: SideCarClient,
  state: LoopState,
  signal: AbortSignal,
  callbacks: AgentCallbacks,
  requestTimeoutMs: number,
  firstTokenTimeoutMs: number = 0,
): Promise<TurnResult> {
  const fullTextParts: string[] = [];
  const fullThinkingParts: string[] = [];
  const pendingToolUses: ToolUseContentBlock[] = [];
  let stopReason = 'end_turn';
  let terminated: TurnTermination = 'none';

  // In plan mode the model writes a plan rather than executing code.
  // ask_user is allowed so the model can request clarification before
  // committing to an approach. All file-system and execution tools are
  // blocked across every plan-mode iteration — the model only gets them
  // after the user approves the plan and the loop re-runs in normal mode.
  // Weak-tier models get ZERO tools in plan mode: ask_user as the only
  // catalog entry is an attractor they cannot resist (3/3 redundant
  // questions in dogfood), and the plan-approval step already gives the
  // user a correction point. Gated on the adaptive-scaffolding profile —
  // behavior-neutral when A2 is off.
  const planTools =
    state.scaffoldingProfile?.planModeAskUser === false ? [] : state.tools.filter((t) => t.name === 'ask_user');
  const iterTools = state.approvalMode === 'plan' ? planTools : state.tools;

  // Augment the system prompt with retrieved episodic context when the
  // store has relevant prior summaries. Falls back gracefully — if
  // episodic retrieval errors or returns nothing, the original prompt
  // (or override) is used unchanged.
  const episodicAddon = await Promise.race([buildEpisodicAddon(client, state), abortedPromise(signal)]);
  // Externalized plan (S1): re-inject the current <plan_state> every turn so
  // the plan survives compression and long-horizon drift — the harness
  // re-supplies what the message window can lose. Before a plan exists, a
  // small nudge stands in: a cold local model does not adopt a new planning
  // tool from its description alone (probe: 0 update_plan calls without
  // this). Lives in the per-turn addon slot, NOT the base prompt, so the
  // cache-stable prefix is untouched and the nudge self-removes once the
  // model creates a plan.
  const planAddon = state.planRef.plan
    ? renderPlanState(state.planRef.plan, {
        complete:
          state.planRef.plan.current === state.planRef.plan.steps.length &&
          planStepWriteTargetsNotWritten(state.planRef.plan, state.gateState.editedFiles).length === 0,
      })
    : state.config.planExternalizedEnabled && state.approvalMode !== 'plan'
      ? '<plan_state>\nNo plan yet. If this task takes more than one step, call update_plan with the full step list (steps=[...], current=1) in the SAME message as your first real tool call — planning must not cost an extra turn.\n</plan_state>'
      : undefined;
  const addons = [episodicAddon, planAddon].filter(Boolean).join('\n\n');
  const effectiveSystemPrompt = addons
    ? (state.systemPromptOverride ?? client.getSystemPrompt()) + '\n\n' + addons
    : state.systemPromptOverride;

  // Per-turn AbortController for timeouts. Aborting this controller
  // cancels the underlying fetch TCP connection immediately — unlike
  // iter.return() which only schedules a return at the next await
  // point and doesn't close the socket.
  const timeoutController = new AbortController();
  const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);

  const stream = client.streamChat(
    state.messages,
    combinedSignal,
    iterTools,
    effectiveSystemPrompt,
    state.modelOverride,
  );
  const iter = stream[Symbol.asyncIterator]();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // Arms (or re-arms) the stall timer. When it fires it aborts the
  // timeout controller, which propagates through combinedSignal and
  // closes the underlying fetch socket. Passing ms <= 0 disables it.
  const armTimeout = (ms: number) => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (ms <= 0) return;
    timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, ms);
  };

  // First-token wait: local models may need time to load from disk
  // or warm the KV cache. Tighten to requestTimeoutMs once streaming
  // has begun, so mid-stream stalls are caught promptly.
  armTimeout(firstTokenTimeoutMs > 0 ? firstTokenTimeoutMs : requestTimeoutMs);

  try {
    while (true) {
      if (combinedSignal.aborted) {
        terminated = timedOut ? 'timeout' : 'aborted';
        break;
      }

      // Race against combinedSignal so that:
      //   - real generators: abort closes the underlying fetch TCP connection
      //   - mock generators (tests): the race interrupts a hanging next()
      const result = await raceWithAbort(iter.next(), combinedSignal);
      // Reset the stall timer on every event (switch from first-token
      // wait to per-event wait after the first token arrives).
      armTimeout(requestTimeoutMs);

      if (result.done) break;
      const event = result.value;

      switch (event.type) {
        case 'text':
          fullTextParts.push(event.text);
          state.totalChars += event.text.length;
          callbacks.onCharsConsumed?.(event.text.length);
          callbacks.onText(event.text);
          break;
        case 'thinking':
          state.totalChars += event.thinking.length;
          callbacks.onCharsConsumed?.(event.thinking.length);
          fullThinkingParts.push(event.thinking);
          const thinkingMode = state.config.thinkingMode;
          thinkingStore.append(state.runId, event.thinking, thinkingMode).catch((err: unknown) => {
            logger.warn('[SideCar] Thinking store append failed:', err instanceof Error ? err.message : err);
          });
          callbacks.onThinking?.(event.thinking);
          break;
        case 'warning':
          callbacks.onText(`\n⚠️ ${event.message}\n`);
          break;
        case 'tool_use':
          pendingToolUses.push(event.toolUse);
          state.logger?.logToolCall(event.toolUse.name, event.toolUse.input);
          callbacks.onToolCall(event.toolUse.name, event.toolUse.input, event.toolUse.id);
          break;
        case 'stop':
          stopReason = event.stopReason;
          break;
        case 'usage':
          // Store actual token counts for the next compression check.
          // Input + output because after this turn the model's output
          // becomes part of the next turn's input context.
          state.lastActualInputTokens = event.usage.inputTokens + event.usage.outputTokens;
          callbacks.onUsage?.(event.usage);
          logApiCall(
            {
              runId: state.runId,
              model: state.config.model,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              stopReason,
              timestamp: new Date().toISOString(),
            },
            state.config.verboseLogs,
          );
          break;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // AbortError from combinedSignal — decide whether it was a stall
      // timeout or a user/outer abort based on which controller fired.
      terminated = timedOut ? 'timeout' : 'aborted';
    } else {
      // Capture the partial before re-throwing so /resume can pick it up.
      // Fire only when we actually accumulated text — empty-partial
      // failures aren't resumable in any useful sense. Listener errors
      // must not mask the original throw, so swallow them here.
      const partial = fullTextParts.join('');
      if (partial.length > 0 && callbacks.onStreamFailure) {
        try {
          callbacks.onStreamFailure(partial, err as Error);
        } catch {
          /* listener errors cannot mask the underlying backend failure */
        }
      }
      throw err;
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    // Ensure the timeout controller is always aborted so the fetch
    // connection is released even on normal completion or re-throw.
    if (!timeoutController.signal.aborted) timeoutController.abort();
    // Best-effort generator cleanup.
    try {
      iter.return?.(undefined);
    } catch {
      /* ignore */
    }
  }

  // Answer-in-thinking fallback. Some models emit their entire final answer via
  // the thinking channel and leave text content empty — e.g. Ollama's qwen3.5
  // under a large system prompt returns the one-sentence answer in
  // `message.thinking` with `message.content` empty. When a turn ended cleanly
  // (not aborted/timed out) with NO text and NO tool call but DID produce
  // thinking, the thinking IS the response, so surface it as text — otherwise
  // the user is left with a blank answer. Fires onText so finalText/observers
  // see it. Never fires when the model produced real text or a tool call.
  if (
    terminated === 'none' &&
    fullTextParts.length === 0 &&
    pendingToolUses.length === 0 &&
    fullThinkingParts.length > 0
  ) {
    const promoted = fullThinkingParts.join('').trim();
    if (promoted) {
      fullTextParts.push(promoted);
      callbacks.onText(promoted);
    }
  }

  return {
    fullText: fullTextParts.join(''),
    pendingToolUses,
    stopReason,
    terminated,
  };
}

/**
 * Post-stream cleanup. Runs after `streamOneTurn` returns and before
 * the orchestrator decides how to proceed:
 *
 *   1. `stripRepeatedContent` removes ≥200-char paragraphs the model
 *      echoed verbatim from earlier assistant turns (prevents stale
 *      content from dominating the next prompt).
 *
 *   2. If the model emitted no structured tool_use blocks but did
 *      produce text, `parseTextToolCalls` looks for XML, `<tool_call>`,
 *      or fenced JSON tool-call patterns. Any found are appended to
 *      `pendingToolUses` and the stop reason is bumped to `'tool_use'`.
 *      `onToolCall` fires for each late-parsed call so observers see
 *      it alongside structured ones.
 *
 * Returns a fresh `TurnResult` rather than mutating the input, so
 * the caller can hold onto both the raw and resolved forms if ever
 * needed (currently only the resolved form is used downstream).
 */
export function resolveTurnContent(turn: TurnResult, state: LoopState, callbacks: AgentCallbacks): TurnResult {
  let fullText = turn.fullText;

  if (fullText) {
    fullText = stripRepeatedContent(fullText, state.messages);
  }

  const pendingToolUses = [...turn.pendingToolUses];
  let stopReason = turn.stopReason;

  if (pendingToolUses.length === 0 && fullText) {
    // Span-aware parse: dispatched text-form calls are EXCISED from the
    // text — the raw JSON/XML must not survive into the assistant message
    // (it rendered as stray call syntax live and dominated restored
    // history, reading as "outputs weren't stored").
    const { calls: parsed, cleanedText } = parseTextToolCallsCleaned(fullText, state.tools);
    for (const tu of parsed) {
      pendingToolUses.push(tu);
      state.logger?.logToolCall(tu.name, tu.input);
      callbacks.onToolCall(tu.name, tu.input, tu.id);
    }
    if (parsed.length > 0) {
      stopReason = 'tool_use';
      fullText = cleanedText;
    }
  }

  return { fullText, pendingToolUses, stopReason, terminated: turn.terminated };
}
