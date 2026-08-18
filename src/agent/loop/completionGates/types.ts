import type { getConfig } from '../../../config/settings.js';
import type { AgentCallbacks, AgentOptions } from '../../loop.js';
import type { LoopState } from '../state.js';

export type GateInjectOutcome = 'injected' | 'skip';

/** Ambient inputs a gate needs beyond the mutable `LoopState`. */
export interface GateContext {
  config: ReturnType<typeof getConfig>;
  options: AgentOptions;
  signal: AbortSignal;
  callbacks: AgentCallbacks;
}

/**
 * One completion-gate component. Each gate owns its config flag (`enabled`),
 * its budget/state (fields on `gateState`), its firing condition, and its
 * reprompt — so it can be read, tested, toggled, and measured in isolation.
 *
 * The registry runs enabled gates in order; the first to return `'injected'`
 * short-circuits the turn (the gate pushed a synthetic user reprompt and the
 * loop re-iterates). A config with every gate's flag off yields the bare loop —
 * the raw-model behavior we want to be able to observe.
 */
export interface CompletionGate {
  readonly name: string;
  enabled(config: ReturnType<typeof getConfig>): boolean;
  maybeInject(state: LoopState, ctx: GateContext): Promise<GateInjectOutcome>;
}
