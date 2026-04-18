// ---------------------------------------------------------------------------
// Pre-turn Role-Based Model Routing hook (v0.64 phase 4b.2).
//
// Runs right before `streamOneTurn` dispatches the next request. When
// the SideCarClient has a router attached (owned by chatState, built
// from `sidecar.modelRouting.rules`), this helper tags the upcoming
// call with `role: 'agent-loop'` and derived signals, lets the router
// pick a model, and surfaces a toast when `visibleSwaps` is on.
//
// When routing is off — no router attached — this helper is a no-op,
// so the legacy static-model behavior is preserved without branching
// at the call site.
// ---------------------------------------------------------------------------

import { window } from 'vscode';
import type { SideCarClient } from '../../ollama/client.js';
import type { RouteSignals } from '../../ollama/modelRouter.js';
import type { ChatMessage } from '../../ollama/types.js';
import type { LoopState } from './state.js';

export interface AgentLoopRoutingConfig {
  /** Whether to surface a toast when the router swaps the active model. */
  modelRoutingVisibleSwaps: boolean;
  /** When true, log the routing decision without actually swapping the model. */
  modelRoutingDryRun: boolean;
}

/**
 * Compute the signals for an agent-loop dispatch and apply the router
 * decision in-place on the client. Returns `true` when a visible-swap
 * toast fired so the caller can log it; otherwise `false` (which
 * includes the "no router attached" and "router matched but swap was
 * already done" cases).
 */
export function applyAgentLoopRouting(
  client: SideCarClient,
  state: LoopState,
  config: AgentLoopRoutingConfig,
): boolean {
  if (!client.getRouter()) return false;

  const signals: RouteSignals = {
    role: 'agent-loop',
    turnCount: state.iteration,
    prompt: extractUserPrompt(state.messages),
    consecutiveToolUseBlocks: countLastAssistantToolUses(state.messages),
  };

  // Dry-run path: call the router to compute the decision + log it,
  // but revert the model back to whatever it was before so dispatch
  // still uses the user's configured `sidecar.model`. We also resync
  // the router's internal `activeModel` to the reverted value — without
  // this resync, `router.activeModel` would disagree with the real
  // client state, and the first post-dry-run swap (if the user flips
  // the flag off mid-session) would suppress its toast because the
  // router thinks it's already on the routed model.
  if (config.modelRoutingDryRun) {
    const preDryRunModel = client.getModel();
    const decision = client.routeForDispatch(signals);
    if (decision && decision.matched) {
      console.info(
        `[SideCar modelRouting dryRun] would route ${signals.role} → ${decision.model} ` +
          `(rule: ${decision.matched.when}); staying on ${preDryRunModel}`,
      );
    }
    client.updateModel(preDryRunModel);
    client.getRouter()?.setInitialActiveModel(preDryRunModel);
    return false;
  }

  const decision = client.routeForDispatch(signals);
  if (!decision) return false;

  // Downgrade notification fires once per rule per session. The user
  // wants to know each budget cap that trips, but not every subsequent
  // turn while the downgrade remains sticky. Independent of
  // `visibleSwaps` — a budget-trip is a meaningful event the user
  // should always see, even when they've silenced routine swap toasts.
  if (decision.downgraded && decision.matched) {
    const router = client.getRouter();
    if (router?.claimDowngradeNotification(decision.matched)) {
      void window.showWarningMessage(
        `SideCar: budget cap hit on rule \`${decision.matched.when}\` — downgrading to ${decision.model}.`,
      );
    }
    return false;
  }

  if (decision.swap && config.modelRoutingVisibleSwaps) {
    const ruleText = decision.matched ? `rule: ${decision.matched.when}` : 'default model';
    void window.showInformationMessage(`SideCar: switched to ${decision.model} (${ruleText})`);
    return true;
  }
  return false;
}

/** Find the first user message in the conversation — the initial prompt. */
function extractUserPrompt(messages: readonly ChatMessage[]): string | undefined {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    for (const block of msg.content) {
      if (block.type === 'text') return block.text;
    }
  }
  return undefined;
}

/**
 * Count `tool_use` blocks in the most recent assistant message. Used as
 * the `consecutiveToolUseBlocks` signal for the complexity heuristic —
 * an assistant turn with 8+ tool_use blocks is a strong "this is a
 * tool-heavy pass, promote to the high-capability model" signal.
 */
function countLastAssistantToolUses(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') return 0;
    let count = 0;
    for (const block of msg.content) {
      if (block.type === 'tool_use') count++;
    }
    return count;
  }
  return 0;
}
