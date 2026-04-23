import type { ChatMessage, ToolDefinition } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { recordToolSuccess, recordToolFailure } from '../ollama/ollamaBackend.js';
import type { InlineEditFn } from './executor.js';
import type { ClarifyFn } from './tools.js';
import type { ToolRuntime } from './tools/runtime.js';
import { getConfig } from '../config/settings.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';
import { type ApprovalMode, type ConfirmFn, type DiffPreviewFn, type StreamingDiffPreviewFn } from './executor.js';
import type { AgentLogger } from './logger.js';
import type { ChangeLog } from './changelog.js';
import type { MCPManager } from './mcpManager.js';
import { compressMessages, applyBudgetCompression, maybeCompressPostTool } from './loop/compression.js';
import { initLoopState } from './loop/state.js';
import { parseTextToolCalls, stripRepeatedContent } from './loop/textParsing.js';
import { streamOneTurn, resolveTurnContent } from './loop/streamTurn.js';
import { applyAgentLoopRouting } from './loop/routing.js';
import { exceedsBurstCap, detectCycleAndBail } from './loop/cycleDetection.js';
import {
  pushAssistantMessage,
  pushToolResultsMessage,
  accountToolTokens,
  capToolResults,
} from './loop/messageBuild.js';
import { runCriticChecks, type RunCriticOptions } from './loop/criticHook.js';
import { HookBus, type PolicyHook, type HookContext } from './loop/policyHook.js';
import { defaultPolicyHooks } from './loop/builtInHooks.js';
import { buildRegressionGuardHooks } from './guards/regressionGuardHook.js';
import { getSdkHooks } from '../sdk/registry.js';
import { dispatchPendingToolUses } from './loop/dispatchToolUses.js';
import { notifyIterationStart, maybeEmitProgressSummary, shouldStopAtCheckpoint } from './loop/notifications.js';
import { finalize } from './loop/finalize.js';
import { drainSteerQueueAtBoundary } from './loop/steerDrain.js';
import type { SteerQueue } from './steerQueue.js';
export { compressMessages, parseTextToolCalls, stripRepeatedContent };
// runCriticChecks + RunCriticOptions were extracted into
// ./loop/criticHook.ts. Re-exported so critic.runner.test.ts still
// imports them from './loop.js' without a coordinated rewrite.
export { runCriticChecks };
export type { RunCriticOptions };
import type { PendingEditStore } from './pendingEdits.js';

export interface AgentCallbacks {
  onText: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>, id: string) => void;
  onToolResult: (name: string, result: string, isError: boolean, id: string) => void;
  /** Streaming output from long-running tools (e.g., shell commands). */
  onToolOutput?: (name: string, chunk: string, id?: string) => void;
  onPlanGenerated?: (plan: string) => void;
  /** Record a learned pattern or decision to agent memory. */
  onMemory?: (type: 'pattern' | 'decision' | 'convention' | 'failure', context: string, content: string) => void;
  /** Record a tool use for chain tracking. */
  onToolChainRecord?: (toolName: string, succeeded: boolean) => void;
  /** Flush the tool chain buffer (call at end of loop). */
  onToolChainFlush?: () => void;
  onIterationStart?: (info: {
    iteration: number;
    maxIterations: number;
    elapsedMs: number;
    estimatedTokens: number;
    messageCount: number;
    messagesRemaining: number;
    atCapacity: boolean;
  }) => void;
  /** Suggest next steps after the agent loop completes. */
  onSuggestNextSteps?: (suggestions: string[]) => void;
  /**
   * Multi-file edit plan produced by the Edit Plan pass (v0.65 chunk
   * 4.3). Fires once per eligible turn, before the plan executes, so
   * the UI can render the "Planned edits" card (chunk 4.4). Receives
   * the normalized + validated plan ready for layered dispatch.
   */
  onEditPlan?: (plan: import('./editPlan.js').EditPlan) => void;
  /**
   * Per-file progress updates as the DAG executor walks the plan
   * (v0.66 chunk 1, deferred 4.4b slim). Each edit transitions:
   *   `pending` (initial, set by dispatchToolUses right after
   *     onEditPlan fires)
   *   → `writing` (when its layer dispatches)
   *   → `done` / `failed` / `aborted` (on completion)
   * The UI maps these to status glyphs on each Planned Edits card
   * row so the user can see which writes are in flight, finished,
   * or blocked — without needing a separate N-stream diff panel.
   * `errorMessage` populates on `failed` transitions.
   */
  onEditPlanProgress?: (update: {
    path: string;
    status: 'pending' | 'writing' | 'done' | 'failed' | 'aborted';
    errorMessage?: string;
  }) => void;
  /** Emit a progress summary during multi-step loops. */
  onProgressSummary?: (summary: string) => void;
  /** Checkpoint: ask user whether to continue a long-running task. Returns true to continue. */
  onCheckpoint?: (summary: string, iterationsUsed: number, iterationsRemaining: number) => Promise<boolean>;
  /** Called when characters are consumed against the budget (for parent token tracking). */
  onCharsConsumed?: (chars: number) => void;
  /**
   * Fired when a stream fails mid-turn with a recoverable (non-abort)
   * error after at least some text had already been received. `partial`
   * is the concatenated text accumulated before the throw — caller
   * stashes it so a later `/resume` command can re-issue the turn with
   * the partial as a continuation hint. Fires before the error
   * propagates, so listeners shouldn't throw from this handler.
   */
  onStreamFailure?: (partial: string, error: Error) => void;
  onDone: () => void;
}

export interface AgentOptions {
  maxIterations?: number;
  maxTokens?: number;
  approvalMode?: ApprovalMode;
  logger?: AgentLogger;
  changelog?: ChangeLog;
  mcpManager?: MCPManager;
  confirmFn?: ConfirmFn;
  diffPreviewFn?: DiffPreviewFn;
  inlineEditFn?: InlineEditFn;
  streamingDiffPreviewFn?: StreamingDiffPreviewFn;
  clarifyFn?: ClarifyFn;
  /** Current sub-agent nesting depth (0 = top-level). Used to enforce MAX_AGENT_DEPTH. */
  depth?: number;
  /** Per-tool permission overrides from the active custom mode. */
  modeToolPermissions?: Record<string, 'allow' | 'deny' | 'ask'>;
  /**
   * Shadow store for review-mode edits. When set and approvalMode is
   * 'review', the executor captures write_file / edit_file calls here
   * instead of touching disk. Forwarded from extension activation.
   */
  pendingEdits?: PendingEditStore;
  /**
   * Override the tool list sent to the model. Used by the local
   * delegate-task worker to hand the model a read-only subset so it
   * can't attempt writes or recursively re-delegate. When unset, the
   * loop calls `getToolDefinitions()` for the full catalog.
   */
  toolOverride?: ToolDefinition[];
  /**
   * Ephemeral `RegisteredTool[]` scoped to this run (v0.66 chunk 3.4b).
   * Threaded into the executor so the tool dispatch path can resolve
   * them BEFORE consulting the global `TOOL_REGISTRY`. Used by the
   * Facet dispatcher to install per-facet `rpc.<peerId>.<method>`
   * tools without mutating the global registry. The loop does NOT
   * include these in `toolOverride` automatically — callers that
   * want the model to SEE these tools must also add their definitions
   * to `toolOverride`.
   */
  extraTools?: readonly import('./tools/shared.js').RegisteredTool[];
  /**
   * Per-run ToolRuntime. When set, tools that need a persistent shell
   * session (run_command, run_tests) resolve it from this runtime
   * rather than the process-wide default — the whole point being
   * that parallel background agents can each cd/export/alias without
   * stomping on each other. The loop threads this into the executor
   * context on every tool call. Caller owns disposal.
   */
  toolRuntime?: ToolRuntime;
  /**
   * Command filter for run_command/run_tests. When set, any command
   * that doesn't pass this predicate is rejected BEFORE execution.
   * Used by the delegate_task local worker to restrict commands to
   * a safe read-only subset (grep, cat, find, ls, etc.).
   */
  commandFilter?: (command: string) => boolean;
  /**
   * Extra policy hooks registered after the four built-in ones
   * (auto-fix, stub validator, critic, completion gate). Runs in
   * registration order inside the same HookBus as the built-ins;
   * later hooks see the mutations earlier hooks made to state.messages.
   *
   * Intended for plugin / skill / CLAUDE.md-driven policy extension.
   * Leave unset for the default behavior — the built-ins run the same
   * way they did before v0.54.
   */
  extraPolicyHooks?: PolicyHook[];
  /**
   * Working-directory override for all tool calls this loop dispatches.
   * When set, every `ToolExecutorContext` built by the loop carries
   * `cwd = cwdOverride`, so fs-tool operations (`read_file`,
   * `write_file`, `edit_file`, `list_directory`) resolve relative paths
   * against this directory instead of the first workspace folder.
   *
   * Used by ShadowWorkspace (v0.59) to route agent writes into an
   * ephemeral worktree at `.sidecar/shadows/<task-id>/` so the user's
   * main tree stays pristine until the shadow's diff is accepted. The
   * helper in `agent/shadow/sandbox.ts` wraps `runAgentLoop` with this
   * option set.
   */
  cwdOverride?: string;
  /**
   * Human-in-the-Loop steer queue (v0.65 chunk 3). When provided,
   * the loop drains queued steers into a single synthetic user turn
   * at each iteration boundary and aborts the in-flight stream when
   * an `interrupt`-urgency steer is enqueued mid-turn.
   *
   * Leave unset to preserve legacy single-shot behavior — no drain,
   * no interrupt wiring, no change.
   */
  steerQueue?: SteerQueue;
}

// DEFAULT_MAX_ITERATIONS moved to loop/state.ts along with initLoopState.
export const MAX_AGENT_DEPTH = 3;

export async function runAgentLoop(
  client: SideCarClient,
  messages: ChatMessage[],
  callbacks: AgentCallbacks,
  signal: AbortSignal,
  options: AgentOptions = {},
): Promise<ChatMessage[]> {
  // All run state — immutable inputs (maxIterations, approvalMode,
  // tools) and mutable accumulators (messages, iteration, totalChars,
  // retry maps, gate state, cycle-detection ring) — lives on one
  // object so the extracted helpers can mutate a single reference
  // instead of taking a dozen parameters each. Every mutation site
  // now goes through one of the helpers under src/agent/loop/, so
  // references here are just `state.xxx` — no shadow locals, no
  // sync-around-helper-call dance.
  const state = initLoopState(messages, options);

  // Steer-queue interrupt wiring (v0.65 chunk 3.2). When a steer of
  // urgency `interrupt` is enqueued during an active stream, we need
  // to abort just the current turn — not the whole run — so the next
  // iteration picks up after draining. Strategy: each iteration owns
  // an inner `turnController` whose signal is passed to streamOneTurn.
  // The outer signal (user "Stop" button) is mirrored onto the inner
  // per iteration. A single queue subscription fires for the lifetime
  // of the loop and aborts the currently-active turnController when
  // hasInterrupt() becomes true.
  let currentTurnController: AbortController | null = null;
  const disposeSteerListener =
    options.steerQueue?.onChange(() => {
      if (!options.steerQueue?.hasInterrupt()) return;
      const tc = currentTurnController;
      if (!tc || tc.signal.aborted) return;
      tc.abort();
      state.logger?.info('Steer queue: interrupt-urgency steer aborted in-flight stream');
    }) ?? (() => {});

  // Build the policy hook bus. Four built-in hooks ship by default
  // (auto-fix, stub validator, critic, completion gate); regression
  // guards defined in `sidecar.regressionGuards` register next if the
  // workspace-trust prompt is accepted; extra hooks supplied via
  // options.extraPolicyHooks register last and see every earlier
  // hook's mutations. This replaces the direct helper calls the
  // orchestrator made in v0.53.
  const hookBus = new HookBus();
  hookBus.registerAll(defaultPolicyHooks());
  const regressionGuardHooks = await buildRegressionGuardHooks();
  if (regressionGuardHooks.length > 0) {
    hookBus.registerAll(regressionGuardHooks);
  }
  if (options.extraPolicyHooks) {
    hookBus.registerAll(options.extraPolicyHooks);
  }
  const sdkRegisteredHooks = getSdkHooks();
  if (sdkRegisteredHooks.length > 0) {
    hookBus.registerAll(sdkRegisteredHooks);
  }

  try {
    while (state.iteration < state.maxIterations) {
      state.iteration++;
      if (signal.aborted) {
        state.logger?.logAborted();
        break;
      }

      const config = getConfig();

      // Drain any pending user steers at the iteration boundary (v0.65
      // chunk 3.2). Pushes a single coalesced user message so the
      // upcoming streamOneTurn call sees the new intent. No-op when
      // steerQueue is unset or empty.
      await drainSteerQueueAtBoundary(state, options.steerQueue, signal, callbacks, {
        coalesceWindowMs: config.steerQueueCoalesceWindowMs,
      });

      // Pre-turn budget compression. Returns 'exhausted' when
      // compaction couldn't bring us below the hard ceiling.
      const compressionOutcome = await applyBudgetCompression(client, state);
      if (compressionOutcome === 'exhausted') {
        const estimatedTokens = Math.ceil(state.totalChars / CHARS_PER_TOKEN);
        state.logger?.warn(
          `Token budget exceeded after compaction: ~${estimatedTokens} tokens > ${state.maxTokens} limit`,
        );
        callbacks.onText(`\n\n⚠️ Agent stopped: token budget exceeded (~${estimatedTokens} tokens).`);
        break;
      }

      state.logger?.logIteration(state.iteration, state.maxIterations);

      notifyIterationStart(state, config, callbacks);
      maybeEmitProgressSummary(state, callbacks);
      if (await shouldStopAtCheckpoint(state, callbacks)) break;

      // Role-Based Model Routing (v0.64). No-op when no router is
      // attached to the client (the default) — preserves legacy
      // static-model dispatch without branching at the call site.
      applyAgentLoopRouting(client, state, {
        modelRoutingVisibleSwaps: config.modelRoutingVisibleSwaps,
        modelRoutingDryRun: config.modelRoutingDryRun,
      });

      // Per-turn AbortController linked to the outer signal. Lets an
      // `interrupt`-urgency steer abort just the current stream (next
      // iteration drains + resumes) without terminating the whole run.
      // When the outer signal fires (user "Stop" button) we mirror it
      // onto the inner so streamOneTurn sees the abort uniformly.
      const turnController = new AbortController();
      currentTurnController = turnController;
      const mirrorAbort = () => turnController.abort();
      if (signal.aborted) {
        turnController.abort();
      } else {
        signal.addEventListener('abort', mirrorAbort, { once: true });
      }

      // Stream the next turn. streamOneTurn handles the per-event
      // timeout, abort, and the full event-type switch;
      // resolveTurnContent runs post-stream cleanup (strip repeated
      // paragraphs, parse text tool calls).
      const requestTimeoutMs = config.requestTimeout * 1000;
      const firstTokenTimeoutMs = config.firstTokenTimeout * 1000;
      let rawTurn;
      try {
        rawTurn = await streamOneTurn(
          client,
          state,
          turnController.signal,
          callbacks,
          requestTimeoutMs,
          firstTokenTimeoutMs,
        );
      } finally {
        signal.removeEventListener('abort', mirrorAbort);
        currentTurnController = null;
      }

      if (rawTurn.terminated === 'timeout') {
        const msg =
          `Request timed out waiting for the model. ` +
          `The model may be loading or the prompt may be too large. ` +
          `You can increase sidecar.firstTokenTimeout (first token) or sidecar.requestTimeout (between tokens) in settings.`;
        state.logger?.warn(msg);
        callbacks.onText(`\n\n⚠️ ${msg}\n`);
        break;
      }
      if (rawTurn.terminated === 'aborted') {
        // Distinguish a real user-stop (outer signal fired) from a
        // steer-driven interrupt (outer still live, inner was aborted
        // by the queue listener). On interrupt: continue the loop so
        // the next iteration drains the queued steer and re-streams.
        if (signal.aborted) break;
        if (options.steerQueue && options.steerQueue.size() > 0) {
          state.logger?.info('Turn aborted by steer interrupt — continuing to next iteration');
          continue;
        }
        break;
      }

      const resolved = resolveTurnContent(rawTurn, state, callbacks);
      const { fullText, pendingToolUses } = resolved;

      // No tools this turn — handle the empty-response branch. Runs
      // the text-tool-attempt heuristic (to record a tool failure on
      // models that tried and failed to call tools) and then gives
      // the completion gate a chance to inject a verification
      // reprompt. If the gate fires, continue the loop; otherwise
      // this is a natural termination.
      if (pendingToolUses.length === 0) {
        const iterTools = state.approvalMode === 'plan' && state.iteration === 1 ? [] : state.tools;
        if (iterTools.length > 0 && fullText) {
          const looksLikeToolAttempt =
            fullText.includes('<function=') ||
            fullText.includes('<tool_call>') ||
            (fullText.includes('"name"') && fullText.includes('"arguments"'));
          if (looksLikeToolAttempt) {
            recordToolFailure(client.getModel());
          }
        }

        // Plan mode: tools were stripped on iteration 1 so the model
        // always lands here (no tool calls). Emit the plan and stop.
        if (options.approvalMode === 'plan' && state.iteration === 1 && fullText) {
          callbacks.onPlanGenerated?.(fullText);
          break;
        }

        // Empty-response phase: the model produced no tool calls this
        // turn. Any hook that implements onEmptyResponse gets a chance
        // to inject a reprompt and keep the loop running (the completion
        // gate is the built-in that does this). If nothing mutates, we
        // break out of the loop.
        const emptyCtx: HookContext = {
          client,
          config,
          options,
          signal,
          callbacks,
          pendingToolUses: [],
          fullText,
        };
        const emptyMutated = await hookBus.runEmptyResponse(state, emptyCtx);
        if (emptyMutated) continue;

        break;
      }

      // Model used tools successfully — reset any failure tracking.
      recordToolSuccess(client.getModel());

      // Per-iteration burst cap + cycle detection. Each returns
      // `true` when the loop should terminate and is responsible for
      // its own user-visible onText notification.
      if (exceedsBurstCap(pendingToolUses, state, callbacks)) break;
      if (detectCycleAndBail(pendingToolUses, state, callbacks)) break;

      // Append the assistant message to history.
      pushAssistantMessage(state, fullText, pendingToolUses);

      // Dispatch every tool_use. For pure-write turns with fanout
      // ≥ multiFileEditsMinFilesForPlan the dispatcher inserts an
      // Edit Plan pass first (v0.65 chunk 4.3) and then walks the
      // resulting DAG with bounded parallelism. Otherwise delegates
      // to the legacy executeToolUses. Either way results are
      // aligned 1:1 with pendingToolUses.
      const toolResults = await dispatchPendingToolUses(
        state,
        pendingToolUses,
        client,
        options,
        callbacks,
        signal,
        config,
      );

      // Cap tool results before accounting so totalChars reflects what
      // the model will actually see. Without this a single broad grep
      // (e.g. "grep kickstand") can return hundreds of KB and exhaust
      // the token budget even in a fresh conversation, because the raw
      // size is counted even though the backend truncates it anyway.
      const storedResults = config.promptPruningEnabled
        ? capToolResults(toolResults, pendingToolUses, config.promptPruningMaxToolResultTokens)
        : toolResults;

      // Token accounting and history append for the tool results.
      accountToolTokens(state, pendingToolUses, storedResults);
      pushToolResultsMessage(state, storedResults);

      // Proactive compression after adding tool results so the next
      // iteration doesn't open over budget.
      maybeCompressPostTool(state);

      // afterToolResults phase: all four built-in hooks fire here in
      // registration order (auto-fix → stub → critic → completion gate
      // tool tracking). Any user-supplied extraPolicyHooks run after the
      // built-ins. Each hook may push a synthetic user message asking
      // the agent to do more work before ending the turn — the return
      // value is currently informational only, because the loop
      // continues iterating regardless (the tool call sequence is what
      // decides termination via the empty-response branch above).
      const afterCtx: HookContext = {
        client,
        config,
        options,
        signal,
        callbacks,
        pendingToolUses,
        toolResults,
        fullText,
      };
      await hookBus.runAfter(state, afterCtx);

      // Continue the loop — model will respond to tool results.
    }
  } finally {
    disposeSteerListener();
    currentTurnController = null;
  }

  return finalize(state, callbacks);
}

// The adversarial critic runner (runCriticChecks, RunCriticOptions,
// buildCriticDiff, extractAgentIntent) lives in ./loop/criticHook.ts.
// runCriticChecks + RunCriticOptions are re-exported near the top of
// this file so critic.runner.test.ts keeps its existing import path.

// parseTextToolCalls + stripRepeatedContent were extracted into
// ./loop/textParsing.ts. Re-exported at the top of this file so
// existing imports in loop.test.ts keep working.
