import { applyAutoFix } from './autoFix.js';
import { applyIsolateRewriteNudge } from './isolateRewrite.js';
import { applyUnappliedEditNudge } from './unappliedEdit.js';
import { applyStubCheck } from './stubCheck.js';
import { applyCritic, applyAnalysisCritic } from './criticHook.js';
import { recordGateToolUses, maybeInjectCompletionGate } from './gate.js';
import { maybeInjectActionReprompt } from './actionReprompt.js';
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

/**
 * Isolate-don't-regenerate nudge. Fires when the model overwrites a whole file
 * with write_file instead of making a targeted edit_file change — the thrash
 * pattern that loses working parts and never converges. Redirects toward
 * targeted edits *before* cycle detection bails the run. Registered right after
 * auto-fix so a turn with both errors and a full rewrite gets "fix these" plus
 * "and do it with a targeted edit".
 */
const isolateRewriteHook: PolicyHook = {
  name: 'isolateRewrite',
  async afterToolResults(state: LoopState, ctx: HookContext): Promise<HookResult> {
    if (!ctx.pendingToolUses) return { mutated: false };
    const mutated = applyIsolateRewriteNudge(state, ctx.pendingToolUses, ctx.callbacks);
    return { mutated };
  },
};

/**
 * Unapplied-edit nudge. The mirror of isolateRewrite: fires when the model
 * described an edit in a code fence but applied NOTHING (no mutation tool) and
 * then tried to verify it. Redirects the model to actually call edit_file /
 * write_file before cycle detection bails on the identical-failure loop. Bounded
 * to one injection per run. Registered after isolateRewrite so the two "how you
 * edit" nudges sit together.
 */
const unappliedEditHook: PolicyHook = {
  name: 'unappliedEdit',
  async afterToolResults(state: LoopState, ctx: HookContext): Promise<HookResult> {
    if (!ctx.pendingToolUses || ctx.fullText === undefined) return { mutated: false };
    const mutated = applyUnappliedEditNudge(state, ctx.pendingToolUses, ctx.fullText, ctx.callbacks);
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

/**
 * Adversarial critic — fires at COMPLETION, not after every edit.
 *
 * It used to run in `afterToolResults`, once per successful write_file /
 * edit_file. That made it review half-finished work: on a multi-file change it
 * judged file A alone, before file B existed, and reported the real-but-
 * irrelevant problems of an incomplete job. With blocking on, it then sent the
 * agent off to fix a phantom — the early-bail signature in the SWE-bench
 * ablation (~7.5x faster termination, MORE empty patches).
 *
 * A critic reviews work. So it runs where the work is finished: onEmptyResponse,
 * over the cumulative diff of every file the run edited.
 */
const criticHook: PolicyHook = {
  name: 'adversarialCritic',
  async onEmptyResponse(state: LoopState, ctx: HookContext): Promise<HookResult> {
    if (ctx.fullText === undefined) return { mutated: false };
    const messagesBefore = state.messages.length;
    await applyCritic(state, ctx.client, ctx.config, ctx.fullText, ctx.callbacks, ctx.signal);
    // applyCritic returns void — detect whether it injected by
    // checking the history length. Slightly unclean but the
    // underlying helper's return shape is already committed to tests.
    return { mutated: state.messages.length > messagesBefore };
  },
};

/**
 * Action-request reprompt — fires in onEmptyResponse when the model
 * produced text only on a turn that looks like an action request
 * (action verb + file path in user message). Injects one re-prompt
 * telling the model to use tools instead of describing what to do.
 * Capped at 1 injection per run so a model that can't tool-call
 * doesn't loop forever.
 */
const actionRepromptHook: PolicyHook = {
  name: 'actionReprompt',
  async onEmptyResponse(state: LoopState, ctx: HookContext): Promise<HookResult> {
    const mutated = maybeInjectActionReprompt(state, ctx.fullText ?? '', ctx.callbacks);
    return { mutated };
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
 * Adversarial analysis critic (scaffolding roadmap V2). Fires on the final
 * answer of a read-only analysis/review turn, fact-checking its claims against
 * the read-evidence the agent gathered. Registered AFTER completionGate so the
 * cheap deterministic gates (V1 citation check, no-grounding) run first and the
 * expensive LLM critic only weighs in on otherwise-clean final answers.
 * Gated behind `criticEnabled` inside applyAnalysisCritic — default off.
 */
const analysisCriticHook: PolicyHook = {
  name: 'analysisCritic',
  async onEmptyResponse(state: LoopState, ctx: HookContext): Promise<HookResult> {
    if (ctx.fullText === undefined) return { mutated: false };
    const before = state.messages.length;
    await applyAnalysisCritic(state, ctx.client, ctx.config, ctx.fullText, ctx.callbacks, ctx.signal);
    return { mutated: state.messages.length > before };
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
  // actionRepromptHook runs before completionGate so the model gets
  // nudged to call tools before the gate demands verification of edits
  // it hasn't made yet.
  return [
    autoFixHook,
    isolateRewriteHook,
    unappliedEditHook,
    stubCheckHook,
    criticHook,
    actionRepromptHook,
    completionGateHook,
    analysisCriticHook,
  ];
}
