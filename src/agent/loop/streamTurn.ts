import type { SideCarClient } from '../../ollama/client.js';
import type { StreamEvent, ToolUseContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import { parseTextToolCalls, stripRepeatedContent } from './textParsing.js';
import { ThinkingStore } from '../thinking/thinkingStore.js';
import { getConfig } from '../../config/settings.js';

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

// Sentinel used inside Promise.race for the per-event timeout. String-tagged
// so we can differentiate from real errors without swallowing them.
const REQUEST_TIMEOUT_SENTINEL = '__REQUEST_TIMEOUT__';

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
  const pendingToolUses: ToolUseContentBlock[] = [];
  let stopReason = 'end_turn';
  let terminated: TurnTermination = 'none';

  // In plan mode, first iteration runs without tools to generate a plan.
  // The orchestrator owns the plan-return short-circuit; this helper just
  // gates tools out of the first request.
  const iterTools = state.approvalMode === 'plan' && state.iteration === 1 ? [] : state.tools;

  const stream = client.streamChat(state.messages, signal, iterTools);
  const iter = stream[Symbol.asyncIterator]();
  let receivedFirstToken = false;
  try {
    while (true) {
      if (signal.aborted) {
        terminated = 'aborted';
        break;
      }

      // Use firstTokenTimeoutMs for the initial wait, then requestTimeoutMs
      // for subsequent events. Local models (Ollama) may need extra time
      // to load from disk or warm up the KV cache before producing the
      // first token, while mid-stream gaps are a reliable sign of a stall.
      const activeTimeoutMs = !receivedFirstToken && firstTokenTimeoutMs > 0 ? firstTokenTimeoutMs : requestTimeoutMs;

      // Race the next stream event against the timeout. Clear the
      // timer when next() wins so we don't leak timers and keep the
      // event loop alive longer than needed.
      let result: IteratorResult<StreamEvent>;
      if (activeTimeoutMs > 0) {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const nextPromise = iter.next();
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(REQUEST_TIMEOUT_SENTINEL)), activeTimeoutMs);
        });
        try {
          result = await Promise.race([nextPromise, timeoutPromise]);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
      } else {
        result = await iter.next();
      }
      receivedFirstToken = true;

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
          const thinkingMode = getConfig().thinkingMode;
          thinkingStore.append(state.taskId, event.thinking, thinkingMode).catch(() => {
            // Silently ignore thinking store errors
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
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message === REQUEST_TIMEOUT_SENTINEL) {
      terminated = 'timeout';
      // Best-effort cleanup — the generator may not support return().
      try {
        iter.return?.(undefined);
      } catch {
        /* stream cleanup is best-effort */
      }
    } else if (err instanceof Error && err.name === 'AbortError') {
      terminated = 'aborted';
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
    const parsed = parseTextToolCalls(fullText, state.tools);
    for (const tu of parsed) {
      pendingToolUses.push(tu);
      state.logger?.logToolCall(tu.name, tu.input);
      callbacks.onToolCall(tu.name, tu.input, tu.id);
    }
    if (parsed.length > 0) {
      stopReason = 'tool_use';
    }
  }

  return { fullText, pendingToolUses, stopReason, terminated: turn.terminated };
}
