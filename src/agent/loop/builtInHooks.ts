import { applyAutoFix } from './autoFix.js';
import { applyStubCheck } from './stubCheck.js';
import { applyCritic } from './criticHook.js';
import { recordGateToolUses, maybeInjectCompletionGate } from './gate.js';
import type { PolicyHook, HookContext, HookResult } from './policyHook.js';
import type { LoopState } from './state.js';

/**
 * Built-in policy hook adapters.
 *
 * Each hook is a mechanical wrap around an existing helper function —
 * the underlying logic in autoFix.ts / stubCheck.ts / criticHook.ts /
 * gate.ts is untouched. The wrappers only translate from the helpers'
 * ad-hoc arguments + return shapes into the `PolicyHook` interface.
 *
 * Why this layer exists instead of just editing the helpers to
 * implement PolicyHook directly:
 *   - Keeps `applyAutoFix`, `applyCritic`, etc. callable from tests
 *     and other call sites without forcing everything through the bus.
 *   - Makes the v0.54 refactor a pure addition — the old call paths
 *     still work during the transition and in the eval harness.
 *   - The wrappers are short enough that the indirection cost is
 *     negligible (<15 lines each).
 *
 * Order inside `defaultPolicyHooks()` is the same order v0.53 ran them
 * in: auto-fix first (cheapest, catches the most common regression),
 * stub validator second (deterministic text match), critic last (most
 * expensive, gated behind `sidecar.critic.enabled`). Completion gate
 * is both a tool-recording hook AND an empty-response hook — the
 * single adapter implements both phases on one object so there's one
 * thing to enable/disable.
 */

const autoFixHook: PolicyHook = {
  name: 'autoFix',
  async afterToolResults(state: LoopState, ctx: HookContext): Promise<HookResult> {
    if (!ctx.pendingToolUses) return { mutated: false };
    const mutated = await applyAutoFix(state, ctx.pendingToolUses, ctx.config, ctx.callbacks);
    return { mutated };
  },
};

const stubCheckHook: PolicyHook = {
  name: 'stubValidator',
  async afterToolResults(state: LoopState, ctx: HookContext): Promise<HookResult> {
    if (!ctx.pendingToolUses) return { mutated: false };
    // applyStubCheck is synchronous; wrap it in an async return so
    // the bus can await it uniformly.
    const mutated = applyStubCheck(state, ctx.pendingToolUses, ctx.callbacks);
    return { mutated };
  },
};

const criticHook: PolicyHook = {
  name: 'adversarialCritic',
  async afterToolResults(state: LoopState, ctx: HookContext): Promise<HookResult> {
    if (!ctx.pendingToolUses || !ctx.toolResults || ctx.fullText === undefined) {
      return { mutated: false };
    }
    const messagesBefore = state.messages.length;
    await applyCritic(
      state,
      ctx.client,
      ctx.config,
      ctx.pendingToolUses,
      ctx.toolResults,
      ctx.fullText,
      ctx.callbacks,
      ctx.signal,
    );
    // applyCritic returns void — detect whether it injected by
    // checking the history length. Slightly unclean but the
    // underlying helper's return shape is already committed to tests.
    return { mutated: state.messages.length > messagesBefore };
  },
};

/**
 * Completion gate hook — implements both `afterToolResults` (feeds
 * gateState with tool call tracking) and `onEmptyResponse` (fires
 * the gate check when the model tried to terminate without
 * verifying edits). afterToolResults never injects; onEmptyResponse
 * is the one that can push a synthetic reprompt.
 */
const completionGateHook: PolicyHook = {
  name: 'completionGate',
  async afterToolResults(state: LoopState, ctx: HookContext): Promise<HookResult> {
    if (!ctx.pendingToolUses || !ctx.toolResults) return { mutated: false };
    recordGateToolUses(state, ctx.pendingToolUses, ctx.toolResults);
    return { mutated: false };
  },
  async onEmptyResponse(state: LoopState, ctx: HookContext): Promise<HookResult> {
    const outcome = await maybeInjectCompletionGate(state, ctx.config, ctx.options, ctx.signal, ctx.callbacks);
    return { mutated: outcome === 'injected' };
  },
};

/**
 * Default policy hook list registered by `runAgentLoop`. Exported so
 * the orchestrator can register them into a fresh `HookBus` at the
 * top of each run and so tests can assert the default set is what
 * they expect.
 *
 * Note: the completion gate lives at the end of the afterToolResults
 * phase so its tool-call recording sees the fully mutated state
 * (after any earlier injections). This matches v0.53 behavior exactly.
 */
export function defaultPolicyHooks(): PolicyHook[] {
  return [autoFixHook, stubCheckHook, criticHook, completionGateHook];
}
