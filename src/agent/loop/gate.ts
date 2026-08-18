import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import { recordToolCall as recordGateToolCall, checkCompletionGate, buildGateInjection } from '../completionGate.js';
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

import { MAX_GATE_INJECTIONS } from '../../config/constants.js';

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
  const { gateState, logger } = state;

  if (signal.aborted || options.approvalMode === 'plan') return 'skip';

  // Any injection below is scaffold-tail by default; the plan-incomplete
  // branch overrides this to true (primary-work continuation — the keep-best
  // ratchet must not arm on it; see completionGate.ts field doc).
  gateState.lastInjectionWasPrimaryWork = false;

  // Modular completion gates (registry) — the strangler target the gates are
  // migrating into, each an isolated, individually-toggleable module. Order in
  // the registry preserves the historic firing sequence: plan-incomplete,
  // red-check (own flag), the grounding/verification reprompt cluster,
  // behavioral-verification (default OFF), then syntax. The
  // lastInjectionWasPrimaryWork reset above runs before it so plan/red-check can
  // re-latch it when they fire.
  if ((await runGateRegistry(state, { config, options, signal, callbacks })) === 'injected') return 'injected';

  // Skip on config disable / nothing to verify / cap.
  const maxGateInjections = state.scaffoldingProfile?.maxGateInjections ?? MAX_GATE_INJECTIONS;
  const disabled = config.completionGateEnabled === false || gateState.editedFiles.size === 0;

  if (disabled) return 'skip';

  if (gateState.gateInjections >= maxGateInjections) {
    if (gateState.editedFiles.size > 0) {
      logger?.warn(
        `Completion gate exhausted (${maxGateInjections} injections) — allowing termination with unverified edits`,
      );
    }
    return 'skip';
  }

  const findings = await checkCompletionGate(gateState);
  if (findings.length === 0) return 'skip';

  gateState.gateInjections++;
  const injection = buildGateInjection(findings, gateState.gateInjections, maxGateInjections);
  logger?.info(
    `Completion gate fired (#${gateState.gateInjections}/${maxGateInjections}): ${findings.length} unverified edit(s)`,
  );
  callbacks.onText('\n\n🔒 Verifying changes before completion...\n');
  state.messages.push({
    role: 'user',
    content: [{ type: 'text' as const, text: injection }],
  });
  return 'injected';
}
