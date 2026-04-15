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
import { exceedsBurstCap, detectCycleAndBail } from './loop/cycleDetection.js';
import { pushAssistantMessage, pushToolResultsMessage, accountToolTokens } from './loop/messageBuild.js';
import { runCriticChecks, type RunCriticOptions } from './loop/criticHook.js';
import { recordGateToolUses, maybeInjectCompletionGate } from './loop/gate.js';
import { executeToolUses } from './loop/executeToolUses.js';
import { applyPostTurnPolicies } from './loop/postTurnPolicies.js';
import { notifyIterationStart, maybeEmitProgressSummary, shouldStopAtCheckpoint } from './loop/notifications.js';
import { finalize } from './loop/finalize.js';
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
  /** Emit a progress summary during multi-step loops. */
  onProgressSummary?: (summary: string) => void;
  /** Checkpoint: ask user whether to continue a long-running task. Returns true to continue. */
  onCheckpoint?: (summary: string, iterationsUsed: number, iterationsRemaining: number) => Promise<boolean>;
  /** Called when characters are consumed against the budget (for parent token tracking). */
  onCharsConsumed?: (chars: number) => void;
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
   * Per-run ToolRuntime. When set, tools that need a persistent shell
   * session (run_command, run_tests) resolve it from this runtime
   * rather than the process-wide default — the whole point being
   * that parallel background agents can each cd/export/alias without
   * stomping on each other. The loop threads this into the executor
   * context on every tool call. Caller owns disposal.
   */
  toolRuntime?: ToolRuntime;
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

  while (state.iteration < state.maxIterations) {
    state.iteration++;
    if (signal.aborted) {
      state.logger?.logAborted();
      break;
    }

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

    const config = getConfig();
    notifyIterationStart(state, config, callbacks);
    maybeEmitProgressSummary(state, callbacks);
    if (await shouldStopAtCheckpoint(state, callbacks)) break;

    // Stream the next turn. streamOneTurn handles the per-event
    // timeout, abort, and the full event-type switch;
    // resolveTurnContent runs post-stream cleanup (strip repeated
    // paragraphs, parse text tool calls).
    const requestTimeoutMs = config.requestTimeout * 1000;
    const rawTurn = await streamOneTurn(client, state, signal, callbacks, requestTimeoutMs);

    if (rawTurn.terminated === 'timeout') {
      const msg =
        `Request timed out after ${config.requestTimeout}s waiting for the model. ` +
        `The model may be loading or the prompt may be too large. ` +
        `You can increase sidecar.requestTimeout in settings.`;
      state.logger?.warn(msg);
      callbacks.onText(`\n\n⚠️ ${msg}\n`);
      break;
    }
    if (rawTurn.terminated === 'aborted') {
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

      const gateOutcome = await maybeInjectCompletionGate(state, config, options, signal, callbacks);
      if (gateOutcome === 'injected') continue;

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

    // Execute every tool_use in parallel with spawn_agent /
    // delegate_task / normal dispatch. Returned results are
    // aligned 1:1 with pendingToolUses — rejected promises are
    // promoted to synthetic error tool_result blocks inside the
    // helper.
    const toolResults = await executeToolUses(state, pendingToolUses, client, options, callbacks, signal);

    // Feed tool calls into the gate state so the next empty-response
    // turn can decide whether to inject a verification reprompt.
    recordGateToolUses(state, pendingToolUses, toolResults);

    // Token accounting and history append for the tool results.
    accountToolTokens(state, pendingToolUses, toolResults);
    pushToolResultsMessage(state, toolResults);

    // Proactive compression after adding tool results so the next
    // iteration doesn't open over budget.
    maybeCompressPostTool(state);

    // Post-turn policies: auto-fix → stub validator → adversarial
    // critic. Each may push a synthetic user message asking the
    // agent to do more work before ending the turn.
    await applyPostTurnPolicies(state, client, config, pendingToolUses, toolResults, fullText, callbacks, signal);

    // Plan mode: return after first iteration for user approval.
    if (options.approvalMode === 'plan' && state.iteration === 1 && fullText) {
      callbacks.onPlanGenerated?.(fullText);
      break;
    }

    // Continue the loop — model will respond to tool results.
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
