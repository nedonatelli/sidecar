import type { SideCarClient } from '../../ollama/client.js';
import type { ChatMessage } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

// Answer-forcing on non-voluntary termination.
//
// A weak local model often never emits a plain-text final answer — every turn
// is a tool call — so when the loop ends by hitting the iteration cap or by
// cycle/burst detection (NOT by the model voluntarily stopping), the user is
// left with no answer even when the needed data was already gathered. Observed
// live: `error-recovery-to-correct-file` read the right file on its very last
// iteration, then terminated on the cap before it could state the result.
//
// This runs ONE final turn with tools disabled, instructing the model to answer
// from what it already has. It fires only on `max-iterations` / `stuck` — never
// on `natural` (the model already answered), `aborted` (the user stopped
// deliberately), or `out-of-resources` (no budget left to spend on another call).

const FORCE_ON: ReadonlySet<NonNullable<LoopState['termination']>> = new Set(['max-iterations', 'stuck']);

const FINAL_ANSWER_PROMPT =
  "You've reached the step limit for this task. Stop calling tools. " +
  'Using ONLY the information already gathered in the conversation above, write your final answer ' +
  'to my original request now, in plain prose (no tool-call JSON, no code fences unless quoting a file). ' +
  'If you could not fully complete the task, state clearly what you found and what remains unresolved.';

/**
 * Fire a tools-disabled synthesis turn when the loop terminated without the
 * model voluntarily answering. Appends the produced answer to `state.messages`
 * and streams it via `callbacks.onText`. No-op on voluntary/aborted/exhausted
 * termination, on an aborted signal, or when the model returns nothing.
 */
export async function maybeForceFinalAnswer(
  state: LoopState,
  client: SideCarClient,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
): Promise<void> {
  if (!state.termination || !FORCE_ON.has(state.termination)) return;
  if (signal.aborted) return;
  if (state.messages.length === 0) return;

  const synthMessages: ChatMessage[] = [...state.messages, { role: 'user', content: FINAL_ANSWER_PROMPT }];

  let answer = '';
  try {
    // Empty tools array disables tool calling for this turn, so the model can't
    // re-enter the loop it just terminated from.
    for await (const event of client.streamChat(synthMessages, signal, [], undefined, state.modelOverride)) {
      if (event.type === 'text') {
        answer += event.text;
        callbacks.onText(event.text);
      }
    }
  } catch (err) {
    // A failed synthesis must never mask the real termination — swallow and
    // leave the run as it was.
    if (err instanceof Error && err.name === 'AbortError') return;
    state.logger?.warn(`force-final-answer turn failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (answer.trim()) {
    state.messages.push({ role: 'assistant', content: answer });
  }
}
