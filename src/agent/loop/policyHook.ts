import type { SideCarClient } from '../../ollama/client.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import type { LoopState } from './state.js';

/**
 * Policy hook interface for runAgentLoop.
 *
 * Closes the last cycle-2 architectural HIGH: the four built-in
 * post-turn policies (auto-fix, stub validator, adversarial critic,
 * completion gate) used to be called directly from the orchestrator.
 * This interface + `HookBus` below lets them register through a
 * uniform bus instead, which:
 *
 *   1. Makes adding a new policy a one-file change (no orchestrator
 *      edits, no ordering debates in loop.ts),
 *   2. Unblocks user-config-driven policy loading (a future CLAUDE.md
 *      or sidecar.policies setting can register custom hooks without
 *      patching the hot loop),
 *   3. Gives each policy a named identity that can show up in
 *      telemetry and verbose-mode logs.
 *
 * Behavior is preserved exactly: the built-in hooks that ship with
 * v0.54 are mechanical wraps around the existing `applyAutoFix`,
 * `applyStubCheck`, `applyCritic`, `recordGateToolUses`, and
 * `maybeInjectCompletionGate` helpers. The wrapper layer adds zero
 * new state and changes nothing about when each policy fires.
 */

/**
 * Per-call context passed to every hook method. Each method receives
 * the full context object and picks out what it needs — no call-site
 * per-method argument juggling. Optional fields are populated only in
 * the phases where they make sense (e.g. `pendingToolUses` is set on
 * `afterToolResults` and `onEmptyResponse` but undefined on
 * `beforeIteration`).
 */
export interface HookContext {
  client: SideCarClient;
  config: ReturnType<typeof getConfig>;
  options: AgentOptions;
  signal: AbortSignal;
  callbacks: AgentCallbacks;

  /** Tool uses the model emitted this turn. Undefined on beforeIteration. */
  pendingToolUses?: ToolUseContentBlock[];
  /** Tool result blocks after execution. Undefined on beforeIteration and onEmptyResponse. */
  toolResults?: ToolResultContentBlock[];
  /** Concatenated text content the model emitted this turn. */
  fullText?: string;
}

/**
 * What a hook can tell the loop. Returning `void` is equivalent to
 * `{ mutated: false }`. A hook that pushes a synthetic message into
 * `state.messages` must return `{ mutated: true }` so the loop knows
 * to continue to the next iteration instead of terminating.
 */
export interface HookResult {
  /** True when the hook pushed a message to state.messages. */
  mutated: boolean;
  /** Short description for logging / telemetry. */
  reason?: string;
}

/**
 * Single point of extension for runAgentLoop. A hook implements
 * whichever phases it cares about and leaves the rest undefined.
 *
 * Phases, in call order:
 *   - `beforeIteration`: start of each iteration, before streaming.
 *     Intended for future hooks that want to short-circuit or
 *     mutate state before the request goes out. No built-in hook
 *     uses this today.
 *   - `afterToolResults`: after tool execution + history append.
 *     Where auto-fix, stub validator, critic, and the gate's
 *     tool-call recording all fire.
 *   - `onEmptyResponse`: reached when the model produced no tool
 *     calls AND no recoverable text. Where the completion gate
 *     fires its empty-response check — if nothing injects, the
 *     loop breaks.
 *   - `onTermination`: run once at the end, regardless of break
 *     reason. Intended for final telemetry / cleanup. No built-in
 *     hook uses this today.
 */
export interface PolicyHook {
  /** Short identifier used in logs. E.g. 'autoFix', 'stubValidator'. */
  name: string;
  beforeIteration?(state: LoopState, ctx: HookContext): Promise<HookResult | void>;
  afterToolResults?(state: LoopState, ctx: HookContext): Promise<HookResult | void>;
  onEmptyResponse?(state: LoopState, ctx: HookContext): Promise<HookResult | void>;
  onTermination?(state: LoopState, ctx: HookContext): Promise<void>;
}

/**
 * Registration bus for `PolicyHook` instances. Runs each phase in
 * registration order and aggregates `HookResult.mutated` across hooks
 * so the orchestrator can ask "did anyone inject anything this phase?"
 * with a single boolean.
 *
 * Hooks run sequentially rather than in parallel: later hooks see the
 * mutations earlier ones made to `state.messages`, which matters for
 * policies that examine recent history (e.g. a future "dedupe" hook
 * would need to see the auto-fix message before deciding to suppress
 * a redundant stub reprompt).
 *
 * Errors thrown inside a hook are logged via the state logger and
 * swallowed — a buggy hook must not be able to crash the whole
 * agent run. Hook ordering means a crashing hook still allows later
 * hooks to run.
 */
export class HookBus {
  private hooks: PolicyHook[] = [];

  register(hook: PolicyHook): void {
    this.hooks.push(hook);
  }

  registerAll(hooks: PolicyHook[]): void {
    for (const h of hooks) this.register(h);
  }

  /** List the registered hooks in order (for telemetry / tests). */
  list(): readonly PolicyHook[] {
    return this.hooks;
  }

  async runBefore(state: LoopState, ctx: HookContext): Promise<boolean> {
    return this.runPhase('beforeIteration', state, ctx);
  }

  async runAfter(state: LoopState, ctx: HookContext): Promise<boolean> {
    return this.runPhase('afterToolResults', state, ctx);
  }

  async runEmptyResponse(state: LoopState, ctx: HookContext): Promise<boolean> {
    return this.runPhase('onEmptyResponse', state, ctx);
  }

  async runTermination(state: LoopState, ctx: HookContext): Promise<void> {
    for (const h of this.hooks) {
      if (!h.onTermination) continue;
      try {
        await h.onTermination(state, ctx);
      } catch (err) {
        state.logger?.warn(`Policy hook '${h.name}' onTermination threw: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Common phase runner. Iterates registered hooks, invokes the
   * phase method if the hook implements it, catches + logs per-hook
   * errors, and returns true when any hook reported a mutation.
   */
  private async runPhase(
    phase: 'beforeIteration' | 'afterToolResults' | 'onEmptyResponse',
    state: LoopState,
    ctx: HookContext,
  ): Promise<boolean> {
    let anyMutated = false;
    for (const h of this.hooks) {
      const method = h[phase];
      if (!method) continue;
      try {
        const result = await method.call(h, state, ctx);
        if (result && result.mutated) anyMutated = true;
      } catch (err) {
        state.logger?.warn(`Policy hook '${h.name}' ${phase} threw: ${(err as Error).message}`);
      }
    }
    return anyMutated;
  }
}
