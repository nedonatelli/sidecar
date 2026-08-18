import { behavioralVerificationGate } from './behavioralVerificationGate.js';
import { syntaxGate } from './syntaxGate.js';
import type { CompletionGate, GateContext, GateInjectOutcome } from './types.js';
import type { LoopState } from '../state.js';

/**
 * Completion-gate registry — the ordered list of modular gates.
 *
 * Gates migrate here one at a time (strangler pattern) out of the
 * `maybeInjectCompletionGate` monolith; the array order preserves the historic
 * firing sequence. Each gate carries its own enable flag, so a config with every
 * flag off yields the bare loop — exactly the minimal-harness behavior we want
 * to be able to observe and then add back to, one measured component at a time.
 */
export const GATES: readonly CompletionGate[] = [behavioralVerificationGate, syntaxGate];

/**
 * Run each ENABLED gate in order. The first gate to inject a reprompt
 * short-circuits and returns `'injected'`; if no enabled gate fires, `'skip'`.
 * `gates` defaults to the real registry; tests pass a hand-built list.
 */
export async function runGateRegistry(
  state: LoopState,
  ctx: GateContext,
  gates: readonly CompletionGate[] = GATES,
): Promise<GateInjectOutcome> {
  for (const gate of gates) {
    if (!gate.enabled(ctx.config)) continue;
    if ((await gate.maybeInject(state, ctx)) === 'injected') return 'injected';
  }
  return 'skip';
}
