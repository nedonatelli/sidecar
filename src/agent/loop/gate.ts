import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import {
  recordToolCall as recordGateToolCall,
  checkCompletionGate,
  buildGateInjection,
  buildNoReadReprompt,
  buildNoShellReprompt,
  buildNoFileWriteReprompt,
  buildNoGroundingReprompt,
  buildUnverifiedClaimReprompt,
} from '../completionGate.js';
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

const MAX_GATE_INJECTIONS = 2;

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
  for (let idx = 0; idx < pendingToolUses.length; idx++) {
    const tr = toolResults[idx];
    if (tr) recordGateToolCall(state.gateState, pendingToolUses[idx], tr);
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

  // Check: file mentioned in user request but no read tool called for it yet.
  // Fires at most once per run to avoid looping on models that can't comply.
  if (!gateState.noReadRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = buildNoReadReprompt(state.messages);
    if (reprompt) {
      gateState.noReadRepromptFired = true;
      logger?.info('No-read gate fired — file mentioned but no read tool called for it');
      callbacks.onText('\n\n📂 Reading file before answering...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Check: workspace metric query (file count, line count, version, etc.) but
  // no shell command was run. Fires at most once per run.
  if (!gateState.noShellRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = buildNoShellReprompt(state.messages);
    if (reprompt) {
      gateState.noShellRepromptFired = true;
      logger?.info('No-shell gate fired — workspace metric query answered without a shell command');
      callbacks.onText('\n\n🔍 Running shell command to get live data...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Check: open-ended review/evaluation of the codebase or design, but no
  // grounding tool was ever called. Fires at most once per run.
  if (!gateState.noGroundingRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = buildNoGroundingReprompt(state.messages);
    if (reprompt) {
      gateState.noGroundingRepromptFired = true;
      logger?.info('No-grounding gate fired — codebase review answered without reading any code');
      callbacks.onText('\n\n🔎 Reading the code before reviewing it...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Check: analysis/review answer cites paths that don't resolve, or hedges an
  // unverified claim. Fires at most once per run. (Scaffolding roadmap V1.)
  if (!gateState.unverifiedClaimRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = await buildUnverifiedClaimReprompt(state.messages);
    if (reprompt) {
      gateState.unverifiedClaimRepromptFired = true;
      logger?.info('Unverified-claim gate fired — review cited a nonexistent path or an unverified claim');
      callbacks.onText('\n\n🧾 Verifying citations before finishing...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Check: file explicitly named in user request with write intent, but never written to.
  // Fires at most once per run; uses a gentle "if required, make them now" framing so
  // the model can skip it when the file genuinely wasn't part of the task.
  if (!gateState.noFileWriteRepromptFired && config.completionGateEnabled !== false) {
    const reprompt = buildNoFileWriteReprompt(state.messages, gateState.editedFiles);
    if (reprompt) {
      gateState.noFileWriteRepromptFired = true;
      logger?.info('No-file-write gate fired — named file(s) not written');
      callbacks.onText('\n\n📝 Checking named files were written...\n');
      state.messages.push({ role: 'user', content: [{ type: 'text' as const, text: reprompt }] });
      return 'injected';
    }
  }

  // Skip on config disable / nothing to verify / cap.
  const disabled = config.completionGateEnabled === false || gateState.editedFiles.size === 0;

  if (disabled) return 'skip';

  if (gateState.gateInjections >= MAX_GATE_INJECTIONS) {
    if (gateState.editedFiles.size > 0) {
      logger?.warn(
        `Completion gate exhausted (${MAX_GATE_INJECTIONS} injections) — allowing termination with unverified edits`,
      );
    }
    return 'skip';
  }

  const findings = await checkCompletionGate(gateState);
  if (findings.length === 0) return 'skip';

  gateState.gateInjections++;
  const injection = buildGateInjection(findings, gateState.gateInjections, MAX_GATE_INJECTIONS);
  logger?.info(
    `Completion gate fired (#${gateState.gateInjections}/${MAX_GATE_INJECTIONS}): ${findings.length} unverified edit(s)`,
  );
  callbacks.onText('\n\n🔒 Verifying changes before completion...\n');
  state.messages.push({
    role: 'user',
    content: [{ type: 'text' as const, text: injection }],
  });
  return 'injected';
}
