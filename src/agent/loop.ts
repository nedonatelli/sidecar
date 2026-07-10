import type { ChatMessage, ToolDefinition, TokenUsage } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { recordToolSuccess, recordToolFailure } from '../ollama/ollamaBackend.js';
import type { InlineEditFn } from './executor.js';
import type { ClarifyFn } from './tools.js';
import type { ToolRuntime } from './tools/runtime.js';
// getConfig removed — config is now captured once at initLoopState via options.config ?? getConfig()
import { estimateTokensFromState } from '../config/tokenEstimation.js';
import { type ApprovalMode, type ConfirmFn, type DiffPreviewFn, type StreamingDiffPreviewFn } from './executor.js';
import type { AgentLogger } from './logger.js';
import type { ChangeLog } from './changelog.js';
import type { MCPManager } from './mcpManager.js';
import { applyBudgetCompression, maybeCompressPostTool, clearCompressionCache } from './loop/compression.js';
import { initLoopState } from './loop/state.js';
import { streamOneTurn, resolveTurnContent } from './loop/streamTurn.js';
import { isDegenerateText } from './loop/textParsing.js';
import { applyAgentLoopRouting, applyArchitectEditorSplit } from './loop/routing.js';
import { exceedsBurstCap, detectCycleAndBail } from './loop/cycleDetection.js';
import {
  excludeBlockedCircularRewrites,
  resetVerifyCountersForVerifications,
  recordSuccessfulEdits,
  shouldDeferBailForBlockedWrite,
  clearTrackingForDeletedFiles,
  captureLastFailureOutput,
  maybeEscalateBlockedRewrite,
  maybeReleaseEnforceLock,
} from './loop/circularRewrite.js';
import {
  pushAssistantMessage,
  pushToolResultsMessage,
  accountToolTokens,
  capToolResults,
  guardToolResults,
} from './loop/messageBuild.js';
import { HookBus, PolicyEnforcementError, type PolicyHook, type HookContext } from './loop/policyHook.js';
import { defaultPolicyHooks } from './loop/builtInHooks.js';
import { buildRegressionGuardHooks } from './guards/regressionGuardHook.js';
import { getSdkHooks } from '../sdk/registry.js';
import { dispatchPendingToolUses } from './loop/dispatchToolUses.js';
import { repairMalformedToolUses } from './loop/toolCallRepair.js';
import { notifyIterationStart, maybeEmitProgressSummary, shouldStopAtCheckpoint } from './loop/notifications.js';
import { finalize } from './loop/finalize.js';
import { maybeForceFinalAnswer } from './loop/forceFinalAnswer.js';
import {
  captureRatchetOriginals,
  captureScaffoldBoundary,
  evaluateRatchetAtTermination,
  makeWorkspaceRatchetIo,
} from './loop/keepBestRatchetWiring.js';
import { drainSteerQueueAtBoundary } from './loop/steerDrain.js';
import type { SteerQueue } from './steerQueue.js';
import type { PendingEditStore } from './pendingEdits.js';
import type { EditTimelineStore } from './editTimeline.js';
import { resolveModelCapability } from '../ollama/modelCapability.js';
import { resolveScaffoldingProfile } from './scaffoldingProfile.js';

/** Returns a signal that fires when either `a` or `b` fires. */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  return AbortSignal.any([a, b]);
}

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
  /** Full assembled text response for the iteration (fires after tool calls are known). */
  onAssistantText?: (text: string, iteration: number) => void;
  /**
   * Multi-file edit plan produced by the Edit Plan pass (v0.65 chunk
   * 4.3). Fires once per eligible turn, before the plan executes, so
   * the UI can render the "Planned edits" card (chunk 4.4). Receives
   * the normalized + validated plan ready for layered dispatch.
   */
  onEditPlan?: (plan: import('./editPlan.js').EditPlan) => void;
  /**
   * Per-file progress updates as the DAG executor walks the plan
   * . Each edit transitions:
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
  /**
   * Called once per planned edit just before its layer dispatches, with
   * an abort function that cancels only that file's write. The UI uses
   * this to wire per-file cancel buttons on the Planned Edits card.
   * Aborting an individual edit leaves the rest of the DAG running.
   */
  onRegisterEditCancel?: (path: string, cancel: () => void) => void;
  /** Emit a progress summary during multi-step loops. */
  onProgressSummary?: (summary: string) => void;
  /** Checkpoint: ask user whether to continue a long-running task. Returns true to continue. */
  onCheckpoint?: (summary: string, iterationsUsed: number, iterationsRemaining: number) => Promise<boolean>;
  /** Called when characters are consumed against the budget (for parent token tracking). */
  onCharsConsumed?: (chars: number) => void;
  /** Fired once per turn with actual token counts from the provider's usage event. */
  onUsage?: (usage: TokenUsage) => void;
  /**
   * Fired when a stream fails mid-turn with a recoverable (non-abort)
   * error after at least some text had already been received. `partial`
   * is the concatenated text accumulated before the throw — caller
   * stashes it so a later `/resume` command can re-issue the turn with
   * the partial as a continuation hint. Fires before the error
   * propagates, so listeners shouldn't throw from this handler.
   */
  onStreamFailure?: (partial: string, error: Error) => void;
  /**
   * F2 — fired after the constrained-decoding repair pass on a turn's tool
   * calls: how many arrived malformed and how many repair recovered. Feeds the
   * schema-validity + repair-rate diagnostics.
   */
  onMalformedToolCalls?: (malformed: number, repaired: number) => void;
  /**
   * F1 — fired once when the run terminates, with the classified failure
   * bucket (or `null` for a clean success). Feeds the per-model failure
   * distribution that steers where scaffolding effort goes.
   */
  onOutcome?: (bucket: import('./failureTaxonomy.js').FailureBucket | null) => void;
  /** Fired when update_plan changed the externalized plan (S1) — checkpointing hook. */
  onPlanUpdate?: (plan: import('./plans/externalPlan.js').ExternalPlan) => void;
  onDone: () => void;
}

export interface AgentOptions {
  maxIterations?: number;
  maxTokens?: number;
  /** Seed the externalized plan (S1) — used by crash-resume to restore step state. */
  initialPlan?: import('./plans/externalPlan.js').ExternalPlan;
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
   * Session-scoped edit timeline. When set, every real-disk write_file
   * and edit_file call records the file path, original content, and new
   * content so the sidebar timeline can offer per-file revert.
   */
  editTimeline?: EditTimelineStore;
  /**
   * Workspace index instance. When set, `write_file` and `edit_file`
   * invalidate the per-file content cache immediately after each
   * successful write so subsequent turns read fresh content rather
   * than the stale pre-write entry.
   */
  workspaceIndex?: import('./tools/shared.js').ToolExecutorContext['workspaceIndex'];
  /**
   * Override the tool list sent to the model. Used by the local
   * delegate-task worker to hand the model a read-only subset so it
   * can't attempt writes or recursively re-delegate. When unset, the
   * loop calls `getToolDefinitions()` for the full catalog.
   */
  toolOverride?: ToolDefinition[];
  /**
   * Restrict the active tool set to the read-only tier for pure information
   * queries (explain, search, inspect) where write/shell tools add no value
   * and only inflate the prompt. 'read' keeps observation tools only;
   * 'full' (default) sends the complete catalog. Ignored when toolOverride
   * is set — the explicit override always wins.
   */
  toolTier?: 'read' | 'full';
  /**
   * Pre-existing episodic memory store to use for this run. When supplied
   * (from ChatState.episodicMemoryStore), the loop shares one persistent
   * store across all agent runs in the VS Code session — summaries from
   * previous sessions are retrieved by `streamTurn.ts` before each LLM call.
   * When absent, the loop creates a fresh in-memory-only store.
   */
  episodicMemory?: import('./episodicMemory.js').EpisodicMemoryStore;
  /**
   * Ephemeral `RegisteredTool[]` scoped to this run .
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
   * Used by ShadowWorkspace to route agent writes into an
   * ephemeral worktree at `.sidecar/shadows/<task-id>/` so the user's
   * main tree stays pristine until the shadow's diff is accepted. The
   * helper in `agent/shadow/sandbox.ts` wraps `runAgentLoop` with this
   * option set.
   */
  cwdOverride?: string;
  /**
   * Human-in-the-Loop steer queue. When provided,
   * the loop drains queued steers into a single synthetic user turn
   * at each iteration boundary and aborts the in-flight stream when
   * an `interrupt`-urgency steer is enqueued mid-turn.
   *
   * Leave unset to preserve legacy single-shot behavior — no drain,
   * no interrupt wiring, no change.
   */
  steerQueue?: SteerQueue;
  /**
   * Optional config snapshot to use for this run. When set, the loop
   * captures this once at entry and uses it for every iteration instead
   * of calling the global `getConfig()`. Primarily for unit tests —
   * pass a partial `SideCarConfig` to control agent behavior without
   * stubbing the module-level singleton.
   *
   * In production, leave unset and the loop reads live config at loop
   * entry (the default `getConfig()` call in `initLoopState`).
   */
  config?: import('../config/settings.js').SideCarConfig;
  /**
   * Per-run system prompt override. When set, `streamChat` uses this
   * string INSTEAD of the shared `client.systemPrompt` for every turn
   * in this run. This avoids mutating the client's shared system-prompt
   * field in concurrent dispatch scenarios (Facets, sub-agents) where
   * two runs racing on `client.updateSystemPrompt()` / restore corrupt
   * each other's prompts.
   */
  systemPromptOverride?: string;
  /**
   * Per-run model override. When set, every `streamChat` call for this
   * run uses this model name instead of `client.model`. Avoids mutating
   * the shared `client.model` field via `setTurnOverride`/restore in
   * concurrent dispatch scenarios (Facets, fork) where two runs racing
   * on that field corrupt each other's model selection.
   */
  modelOverride?: string;
  /**
   * VS Code TestController for surfacing `run_tests` results in the
   * native Test Explorer panel. When set, the executor calls
   * `testController.reportRun(command, output)` after each test run.
   */
  testController?: import('../testing/testController.js').SidecarTestController;
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

  // Capability-driven scaffolding intensity (A2). Only applied when the user
  // opts in; otherwise scaffoldingProfile stays undefined and the loop reads
  // the historical constants (behavior-neutral). Resolved once at loop start
  // from the active model's tier.
  if (state.config.adaptiveScaffoldingEnabled) {
    state.scaffoldingProfile = resolveScaffoldingProfile(resolveModelCapability(client.getModel()).tier);
  }

  // Keep-best ratchet IO (§2.1). Built once, rooted at the loop's effective
  // working dir (cwdOverride → Shadow Workspace / mounted root). Null when the
  // ratchet is off, so all ratchet touch points below no-op cheaply.
  const ratchetIo = state.ratchet?.enabled ? makeWorkspaceRatchetIo(options.cwdOverride) : null;

  // Start from a clean compression cache. The teardown `finally` also clears
  // it, but clearing here guarantees a fresh slate even if a prior run's
  // teardown was skipped (e.g. a synchronous throw before its finally ran),
  // so a stale cached compression can never leak into this run.
  clearCompressionCache();

  // Steer-queue interrupt wiring. When a steer of
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
        state.termination = 'aborted';
        break;
      }

      // Drain any pending user steers at the iteration boundary (v0.65
      // chunk 3.2). Pushes a single coalesced user message so the
      // upcoming streamOneTurn call sees the new intent. No-op when
      // steerQueue is unset or empty.
      await drainSteerQueueAtBoundary(state, options.steerQueue, signal, callbacks, {
        coalesceWindowMs: state.config.steerQueueCoalesceWindowMs,
      });

      // Pre-turn budget compression. Returns 'exhausted' when
      // compaction couldn't bring us below the hard ceiling.
      const compressionOutcome = await applyBudgetCompression(client, state);
      if (signal.aborted) {
        state.termination = 'aborted';
        break;
      }
      if (compressionOutcome === 'exhausted') {
        state.termination = 'out-of-resources';
        const estimatedTokens =
          state.lastActualInputTokens ?? estimateTokensFromState(state.totalChars, state.messages);
        state.logger?.warn(
          `Token budget exceeded after compaction: ~${estimatedTokens} tokens > ${state.maxTokens} limit`,
        );
        callbacks.onText(`\n\n⚠️ Agent stopped: token budget exceeded (~${estimatedTokens} tokens).`);
        break;
      }

      state.logger?.logIteration(state.iteration, state.maxIterations);

      notifyIterationStart(state, state.config, callbacks);
      maybeEmitProgressSummary(state, callbacks);
      if (await shouldStopAtCheckpoint(state, callbacks)) {
        state.termination = 'aborted';
        break;
      }

      // Architect / Editor model split. No-op when sidecar.editorModel is
      // blank (the default). When set, planning turns use sidecar.model and
      // tool-execution turns use editorModel — reducing cost on long runs.
      // Runs before role-based routing so custom rules can still override.
      applyArchitectEditorSplit(client, state.messages, state.config.model, state.config.editorModel);

      // Role-Based Model Routing. No-op when no router is
      // attached to the client (the default) — preserves legacy
      // static-model dispatch without branching at the call site.
      applyAgentLoopRouting(client, state, {
        modelRoutingVisibleSwaps: state.config.modelRoutingVisibleSwaps,
        modelRoutingDryRun: state.config.modelRoutingDryRun,
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
      const requestTimeoutMs = state.config.requestTimeout * 1000;
      const firstTokenTimeoutMs = state.config.firstTokenTimeout * 1000;
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
        // Keep currentTurnController alive through dispatch so a steer
        // interrupt fired during tool execution can still abort it.
        // The outer finally (loop exit) handles the final null-out.
      }

      if (rawTurn.terminated === 'timeout') {
        const msg =
          `Request timed out waiting for the model. ` +
          `The model may be loading or the prompt may be too large. ` +
          `You can increase sidecar.firstTokenTimeout (first token) or sidecar.requestTimeout (between tokens) in settings.`;
        state.logger?.warn(msg);
        callbacks.onText(`\n\n⚠️ ${msg}\n`);
        state.termination = 'out-of-resources';
        break;
      }
      if (rawTurn.terminated === 'aborted') {
        // Distinguish a real user-stop (outer signal fired) from a
        // steer-driven interrupt (outer still live, inner was aborted
        // by the queue listener). On interrupt: continue the loop so
        // the next iteration drains the queued steer and re-streams.
        if (signal.aborted) {
          // Surface any tool calls that were queued but never executed so the
          // user knows what the agent was about to do when they stopped it.
          if (rawTurn.pendingToolUses.length > 0) {
            const names = rawTurn.pendingToolUses.map((tu) => `\`${tu.name}\``).join(', ');
            callbacks.onText(`\n⚠️ Stopped — cancelled in-flight: ${names}\n`);
          }
          state.termination = 'aborted';
          break;
        }
        if (options.steerQueue && options.steerQueue.size() > 0) {
          state.logger?.info('Turn aborted by steer interrupt — continuing to next iteration');
          continue;
        }
        state.termination = 'aborted';
        break;
      }

      const resolved = resolveTurnContent(rawTurn, state, callbacks);
      const { fullText, pendingToolUses } = resolved;

      // Phase 1: constrained-decoding repair of malformed tool calls — at the
      // action boundary, before dispatch. Heuristic JSON repair first, then a
      // schema-constrained regeneration. Recovers calls that would otherwise
      // error/drop, instead of burning a whole retry turn.
      const malformedCount = pendingToolUses.filter((tu) => tu._malformedInputRaw !== undefined).length;
      if (malformedCount > 0) {
        try {
          const fixed = await repairMalformedToolUses(pendingToolUses, {
            client,
            model: state.modelOverride,
            signal,
            schemaFor: (name) =>
              state.tools.find((t) => t.name === name)?.input_schema as Record<string, unknown> | undefined,
            logger: state.logger,
          });
          callbacks.onMalformedToolCalls?.(malformedCount, fixed); // F2 — schema-validity + repair rate
          state.unrepairedMalformedCalls += malformedCount - fixed; // F1 — syntactic-failure signal
          if (fixed > 0) callbacks.onText?.(`\n\n🔧 Repaired ${fixed} malformed tool call${fixed === 1 ? '' : 's'}.\n`);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          state.unrepairedMalformedCalls += malformedCount; // repair threw — none recovered
        }
      }

      // No tools this turn — handle the empty-response branch. Runs
      // the text-tool-attempt heuristic (to record a tool failure on
      // models that tried and failed to call tools) and then gives
      // the completion gate a chance to inject a verification
      // reprompt. If the gate fires, continue the loop; otherwise
      // this is a natural termination.
      if (pendingToolUses.length === 0) {
        // Degenerate output (token salad) must never stand as a final
        // answer — observed live: a stream of reserved-token literals was
        // accepted as 'done' at iteration 2. Discard the turn (the garbage
        // never enters message history) and retry once with an explicit
        // continue instruction; a second occurrence ends the run labeled
        // 'stuck' instead of returning garbage to the user.
        if (fullText && isDegenerateText(fullText)) {
          state.degenerateTurns += 1;
          if (state.degenerateTurns <= 1) {
            state.logger?.warn('Degenerate model output discarded — retrying');
            callbacks.onText('\n\n⚠️ Discarded corrupted model output — retrying.\n');
            state.messages.push({
              role: 'user',
              content: [
                {
                  type: 'text' as const,
                  text: 'Your previous output was corrupted (repeated or invalid tokens) and has been discarded. Continue the task from the previous step.',
                },
              ],
            });
            continue;
          }
          state.logger?.warn('Degenerate model output recurred — terminating run');
          callbacks.onText('\n\n⚠️ Model output degenerated twice — stopping.\n');
          state.termination = 'stuck';
          break;
        }

        // ask_user is the only tool available in plan mode. A text-only
        // response — on any iteration — means the model has finished
        // asking questions and is presenting its plan.
        if (options.approvalMode === 'plan' && fullText) {
          callbacks.onPlanGenerated?.(fullText);
          state.termination = 'natural';
          break;
        }

        if (state.tools.length > 0 && fullText) {
          const looksLikeToolAttempt =
            fullText.includes('<function=') ||
            fullText.includes('<tool_call>') ||
            (fullText.includes('"name"') && (fullText.includes('"arguments"') || fullText.includes('"parameters"')));
          if (looksLikeToolAttempt) {
            recordToolFailure(client.getModel());
          }
        }

        // Empty-response phase: the model produced no tool calls this
        // turn. Any hook that implements onEmptyResponse gets a chance
        // to inject a reprompt and keep the loop running (the completion
        // gate is the built-in that does this). If nothing mutates, we
        // break out of the loop.
        const emptyCtx: HookContext = {
          client,
          config: state.config,
          options,
          signal,
          callbacks,
          runId: state.runId,
          pendingToolUses: [],
          fullText,
        };
        const emptyMutated = await hookBus.runEmptyResponse(state, emptyCtx);
        if (emptyMutated) {
          // A scaffold reprompt fired (completion gate). Arm the keep-best
          // ratchet at this boundary if it hasn't been — everything the model
          // does in response is scaffold-driven and subject to revert.
          if (ratchetIo) await captureScaffoldBoundary(state, ratchetIo);
          continue;
        }

        // Nothing more to do and no hook kept the loop alive — the model
        // declared itself done. Mark natural completion; the completion gate
        // (a runEmptyResponse hook) would have mutated above if it still had
        // budget, so reaching here means verification is as complete as the
        // gate could make it.
        state.termination = 'natural';
        break;
      }

      // Model used tools successfully — reset any failure tracking.
      recordToolSuccess(client.getModel());

      // Per-iteration burst cap + cycle detection. Each returns
      // `true` when the loop should terminate and is responsible for
      // its own user-visible onText notification.
      if (exceedsBurstCap(pendingToolUses, state, callbacks)) {
        state.termination = 'stuck';
        break;
      }
      // Remove blocked circular rewrites (content byte-identical to a prior
      // write this run) from what cycle detection counts — the write_file
      // executor soft-blocks them, so they shouldn't bail the whole run.
      // Dispatch still sees the full list so the blocked write returns its
      // soft-block result. Bounded per file; once the budget is spent the
      // circular write is left in and cycle detection bails the stuck loop.
      const forCycleDetection = excludeBlockedCircularRewrites(pendingToolUses, state, callbacks);
      // If a pending write will be soft-blocked by the executor (verify-before-
      // rewrite or enforce-edit), defer the cycle bail this turn so dispatch runs
      // and the block + escalation reach the model instead of the run dying with
      // zero feedback. Bounded per file.
      const deferForBlockedWrite = shouldDeferBailForBlockedWrite(pendingToolUses, state, callbacks);
      if (
        !deferForBlockedWrite &&
        forCycleDetection.length > 0 &&
        detectCycleAndBail(forCycleDetection, state, callbacks)
      ) {
        state.termination = 'stuck';
        break;
      }

      // Append the assistant message to history.
      pushAssistantMessage(state, fullText, pendingToolUses);
      if (fullText) callbacks.onAssistantText?.(fullText, state.iteration);

      // Re-check abort between streaming and tool dispatch. The outer
      // loop only checks at iteration start, so a Stop fired during
      // streaming would otherwise still execute all queued tools.
      if (signal.aborted) {
        state.termination = 'aborted';
        break;
      }

      // Dispatch every tool_use. For pure-write turns with fanout
      // ≥ multiFileEditsMinFilesForPlan the dispatcher inserts an
      // Edit Plan pass first and then walks the
      // resulting DAG with bounded parallelism. Otherwise delegates
      // to the legacy executeToolUses. Either way results are
      // aligned 1:1 with pendingToolUses.
      // Combine outer + inner signals: dispatch respects both a full
      // user "Stop" and a steer-interrupt that fired after streaming.
      const dispatchSignal = combineSignals(signal, turnController.signal);

      // Keep-best ratchet: baseline the pre-edit content of every file this
      // turn is about to write, so a scaffold-tail change can be reverted
      // precisely (delete if created this run, restore original otherwise).
      if (ratchetIo) await captureRatchetOriginals(state, pendingToolUses, ratchetIo);

      const toolResults = await dispatchPendingToolUses(
        state,
        pendingToolUses,
        client,
        options,
        callbacks,
        dispatchSignal,
        state.config,
      );

      // Reset the verify-before-rewrite counter for any file this turn actually
      // verified (get_diagnostics / a run or test referencing it), so a model
      // that checks its work between rewrites is never soft-blocked.
      resetVerifyCountersForVerifications(pendingToolUses, state);

      // Record files successfully edited via edit_file so write_file blocks a
      // full rewrite that would clobber those targeted fixes.
      recordSuccessfulEdits(pendingToolUses, toolResults, state);

      // A deleted file is a clean slate — clear its rewrite-thrash tracking so a
      // delete-then-recreate (the natural "start this file over" move) isn't
      // blocked by the enforce-edit lock left over from before the delete.
      clearTrackingForDeletedFiles(pendingToolUses, toolResults, state);

      // Capture the latest failing verification output, then — if the model just
      // looped on an enforce-blocked rewrite — escalate with a strong "edit, don't
      // rewrite" reprompt that surfaces that failure inline so it sees what to fix.
      captureLastFailureOutput(pendingToolUses, toolResults, state);
      maybeEscalateBlockedRewrite(pendingToolUses, toolResults, state, callbacks);

      // If the model keeps trying to rewrite an enforce-locked file and ignores
      // the escalation, release the lock after a few blocks so a rewrite-oriented
      // model can rewrite instead of being trapped into a bail.
      maybeReleaseEnforceLock(pendingToolUses, toolResults, state, callbacks);

      // Emit structured audit record per tool call.
      if (state.logger) {
        for (let i = 0; i < pendingToolUses.length; i++) {
          const outcome = toolResults[i]?.is_error ? 'error' : 'ok';
          state.logger.logToolAudit(state.runId, pendingToolUses[i].name, outcome);
        }
      }

      // Cap tool results before accounting so totalChars reflects what
      // the model will actually see. Without this a single broad grep
      // (e.g. "grep kickstand") can return hundreds of KB and exhaust
      // the token budget even in a fresh conversation, because the raw
      // size is counted even though the backend truncates it anyway.
      const cappedResults = state.config.promptPruningEnabled
        ? capToolResults(toolResults, pendingToolUses, state.config.promptPruningMaxToolResultTokens)
        : toolResults;

      // Prompt-injection guard (§4): fence tool output that carries injection
      // attempts as untrusted data before it reaches the model. Runs after
      // capping so the fence boundary survives truncation.
      const guarded = guardToolResults(cappedResults, pendingToolUses, state.config.injectionGuardEnabled);
      if (guarded.findings.length > 0) {
        for (const f of guarded.findings) {
          state.logger?.warn(`Prompt-injection guard: fenced ${f.tool} output — ${f.categories.join(', ')}`);
        }
        const summary = guarded.findings.map((f) => `${f.tool} (${f.categories.join(', ')})`).join('; ');
        callbacks.onText(`\n\n🛡️ Prompt-injection guard: fenced untrusted content as data — ${summary}\n`);
      }
      const storedResults = guarded.results;

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
        config: state.config,
        options,
        signal,
        callbacks,
        runId: state.runId,
        pendingToolUses,
        toolResults,
        fullText,
      };
      await hookBus.runAfter(state, afterCtx);

      // Continue the loop — model will respond to tool results.
    }
    // Fell out of the while via the iteration-cap condition (every break that
    // reached here set its own reason; an unset reason means the counter ran
    // out). F1 classifies this as a `timeout` bucket.
    state.termination ??= 'max-iterations';
  } catch (err) {
    if (err instanceof PolicyEnforcementError) {
      const msg =
        `\n\n⛔ Agent stopped: policy enforcement failure in hook '${err.hookName}' (${err.phase}).\n` +
        `${err.message}\n\nFix or remove the failing hook before continuing.`;
      state.logger?.error(`policy-enforcement-failure: ${err.message}`);
      callbacks.onText(msg);
      // Do not re-throw — finalize() below fires onDone and flushes cleanly.
    } else {
      // Stash completed iterations before rethrowing so the caller can
      // persist whatever the agent produced before the error hit.
      if (err instanceof Error) {
        (err as Error & { partialMessages?: ChatMessage[] }).partialMessages = [...state.messages];
      }
      // Fire onDone/flush before propagating — without this, the UI
      // spinner stays active forever when the loop throws.
      finalize(state, callbacks);
      throw err;
    }
  } finally {
    disposeSteerListener();
    currentTurnController = null;
    clearCompressionCache();
    // Restore the client to the user's configured model so subsequent
    // non-agent requests (chat, completions) aren't left on editorModel.
    if (state.config.editorModel) {
      client.updateModel(state.config.model);
    }
  }

  // Answer-forcing: the loop hit the iteration cap or a stuck-loop bail without
  // the model voluntarily answering. Run one tools-disabled synthesis turn so
  // the user gets an answer from the data already gathered instead of a wall of
  // tool-call JSON. No-op on natural/aborted/out-of-resources termination.
  await maybeForceFinalAnswer(state, client, callbacks, signal);

  // Keep-best ratchet: at natural completion, revert scaffold-driven changes
  // that regressed a test signal or ballooned the patch with no gain. Skipped
  // on user-abort (the user stopped deliberately — don't touch their files) and
  // when the ratchet never armed (scaffolding drove no extra work).
  if (ratchetIo && state.termination !== 'aborted') {
    await evaluateRatchetAtTermination(state, ratchetIo, callbacks);
  }

  return finalize(state, callbacks);
}
