import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import { recordToolCall as recordGateToolCall } from '../completionGate.js';
import { runGateRegistry } from './completionGates/registry.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Completion gate — post-turn policy, two entry points.
//
// The completion gate tracks which files the agent edited and which
// verification commands (lint, tests) it ran across a turn. When the
// agent tries to terminate without verifying its edits, the gate
// injects a synthetic user message demanding verification, forcing
// the loop to continue.
//
// Two call sites in runAgentLoop:
//
//   1. `recordGateToolUses` — after tool execution, feeds every
//      tool call and result into `gateState` so the tracker knows
//      what was edited and what was verified. Called once per turn.
//
//   2. `maybeInjectCompletionGate` — on the empty-response branch
//      (agent emitted no tools this turn), checks whether the gate
//      should fire. If it should, pushes the injection into history
//      and returns `'injected'` so the orchestrator knows to
//      `continue` the loop instead of breaking. If the gate is
//      disabled, has already fired MAX_GATE_INJECTIONS times, or
//      found nothing to verify, returns `'skip'`.
//
// Bounded to MAX_GATE_INJECTIONS attempts per run so a model that
// can't or won't verify doesn't loop forever — after the cap, the
// gate logs a warning and allows termination with unverified edits.
// ---------------------------------------------------------------------------

/**
 * Feed every tool use + result pair into the gate state so it can
 * track which files were edited and which verification commands
 * have run. Called once per turn, after tool execution finishes.
 *
 * Null / missing results are skipped — a rejected tool promise
 * produces a synthetic error result in the parallel-execution
 * handler, so this helper always sees a result in each slot when
 * execution completed normally.
 */
export function recordGateToolUses(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
): void {
  const mcpToolMeta = state.mcpManager ? (name: string) => state.mcpManager!.getToolMeta(name) : undefined;
  for (let idx = 0; idx < pendingToolUses.length; idx++) {
    const tr = toolResults[idx];
    if (tr) recordGateToolCall(state.gateState, pendingToolUses[idx], tr, mcpToolMeta);
  }
}

/** Outcome of the empty-response gate check. */
export type GateOutcome = 'injected' | 'skip';

/**
 * Decide whether the empty-response branch should fire the completion
 * gate. Returns `'injected'` when the gate pushed a synthetic user
 * message into history (orchestrator should `continue` instead of
 * `break`), `'skip'` otherwise.
 *
 * Skip conditions (any): abort signal fired, plan-mode turn-one
 * return, completion gate disabled in config, no edited files to
 * verify, injection cap already exhausted, or the
 * `checkCompletionGate` check came back clean. When the cap is
 * exhausted we also log a warning on the way out so users can tell
 * the gate gave up.
 */
export async function maybeInjectCompletionGate(
  state: LoopState,
  config: ReturnType<typeof getConfig>,
  options: AgentOptions,
  signal: AbortSignal,
  callbacks: AgentCallbacks,
): Promise<GateOutcome> {
  const { gateState } = state;

  if (signal.aborted || options.approvalMode === 'plan') return 'skip';

  // Any injection is scaffold-tail by default; individual gates (plan-incomplete,
  // red-check) override this to true for primary-work continuations so the
  // keep-best ratchet doesn't arm on them. Reset here, before the registry runs.
  gateState.lastInjectionWasPrimaryWork = false;

  // Every completion gate now lives in the registry, in historic firing order:
  // plan-incomplete, red-check, the grounding/verification reprompt cluster,
  // behavioral-verification (default off), syntax, the code-graph gates, and the
  // base "edited-but-unverified" completion gate last.
  return runGateRegistry(state, { config, options, signal, callbacks });
}
