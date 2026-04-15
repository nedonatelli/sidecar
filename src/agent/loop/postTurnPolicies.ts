import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { getConfig } from '../../config/settings.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import { applyAutoFix } from './autoFix.js';
import { applyStubCheck } from './stubCheck.js';
import { applyCritic } from './criticHook.js';

// ---------------------------------------------------------------------------
// Post-turn policies — composer.
//
// After tool execution, three independent policies may inject a
// synthetic user message asking the model to do more work before
// ending the turn:
//
//   1. **auto-fix** — pull diagnostics for every file the agent just
//      wrote, inject errors back as a reprompt
//   2. **stub validator** — scan the written content for placeholder
//      markers, inject a "finish the implementation" reprompt
//   3. **adversarial critic** — fire an independent LLM call to review
//      the edits, inject blocking findings on high-severity issues
//
// Each policy is independently testable in its own module. This
// composer exists purely to sequence them from the orchestrator —
// the main loop body stays a one-liner instead of three sequential
// awaits.
//
// Policies run in a deliberate order: auto-fix first (cheapest,
// catches the most common regression), stub validator second
// (deterministic text match), critic last (most expensive, gated
// behind `sidecar.critic.enabled`). Each one may push into
// state.messages; later policies see the updated history if any
// earlier one injected.
// ---------------------------------------------------------------------------

/**
 * Run every post-turn policy in sequence: auto-fix → stub → critic.
 * No-ops for each policy when its trigger conditions aren't met
 * (no written files, no stubs detected, critic disabled).
 */
export async function applyPostTurnPolicies(
  state: LoopState,
  client: SideCarClient,
  config: ReturnType<typeof getConfig>,
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  fullText: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
): Promise<void> {
  await applyAutoFix(state, pendingToolUses, config, callbacks);
  applyStubCheck(state, pendingToolUses, callbacks);
  await applyCritic(state, client, config, pendingToolUses, toolResults, fullText, callbacks, signal);
}
