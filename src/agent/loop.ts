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
import { applyStubCheck } from './loop/stubCheck.js';
import { applyCritic, runCriticChecks, type RunCriticOptions } from './loop/criticHook.js';
import { recordGateToolUses, maybeInjectCompletionGate } from './loop/gate.js';
import { applyAutoFix } from './loop/autoFix.js';
import { executeToolUses } from './loop/executeToolUses.js';
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
  // Centralized state container. Immutable inputs (maxIterations,
  // approvalMode, tools, etc.) and mutable state (messages array,
  // iteration counter, totalChars, cycle-detection ring, retry maps,
  // gate state) all live on `state` so extracted helpers can mutate
  // one object instead of taking a dozen parameters. The init logic
  // matches what runAgentLoop used to do inline — copy messages,
  // default options, derive tools, seed totalChars from getContentLength.
  const state = initLoopState(messages, options);

  // Alias state fields so references in the rest of the body stay
  // concise. Reference-type aliases (arrays, maps, the gate state
  // object, the messages array) share the same object as state.*, so
  // in-place mutations propagate both ways automatically.
  const { maxIterations, tools, logger, startTime } = state;
  const agentMessages = state.messages;

  // Primitives (iteration, totalChars, stubFixRetries) can't alias by
  // reference. Keep local mutable copies and sync with `state.xxx`
  // immediately around each extracted-helper call — helpers that read
  // or mutate these fields see the latest value, and the local stays
  // authoritative for the inline code blocks that haven't been
  // extracted yet. Phase 4 will collapse these aliases once every
  // mutation site goes through an extracted helper.
  let iteration = state.iteration;
  let totalChars = state.totalChars;
  let stubFixRetries = state.stubFixRetries;

  const maxTokens = state.maxTokens;

  while (iteration < maxIterations) {
    iteration++;
    if (signal.aborted) {
      logger?.logAborted();
      break;
    }
    // Pre-turn budget compression. Extracted into loop/compression.ts.
    // Sync `totalChars` into state before the call, invoke, sync back
    // out. When compaction can't bring us below the hard ceiling the
    // helper returns 'exhausted' and we bail with a user-visible
    // notification.
    state.totalChars = totalChars;
    const compressionOutcome = await applyBudgetCompression(client, state);
    totalChars = state.totalChars;
    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
    if (compressionOutcome === 'exhausted') {
      logger?.warn(`Token budget exceeded after compaction: ~${estimatedTokens} tokens > ${maxTokens} limit`);
      callbacks.onText(`\n\n⚠️ Agent stopped: token budget exceeded (~${estimatedTokens} tokens).`);
      break;
    }

    logger?.logIteration(iteration, maxIterations);
    const config = getConfig();
    const messageCeiling = config.agentMaxMessages;
    const messageCount = agentMessages.length;
    const messagesRemaining = Math.max(0, messageCeiling - messageCount);
    const atCapacity = messageCount >= messageCeiling;
    callbacks.onIterationStart?.({
      iteration,
      maxIterations,
      elapsedMs: Date.now() - startTime,
      estimatedTokens,
      messageCount,
      messagesRemaining,
      atCapacity,
    });

    // Progress summary every 5 iterations (starting at iteration 5)
    if (iteration > 1 && iteration % 5 === 0 && callbacks.onProgressSummary) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const pctTokens = Math.round((estimatedTokens / maxTokens) * 100);
      callbacks.onProgressSummary(
        `Iteration ${iteration}/${maxIterations} · ${elapsed}s elapsed · ${pctTokens}% context used · ${messageCount} messages`,
      );
    }

    // Checkpoint at 60% of max iterations — let user decide whether to continue
    if (callbacks.onCheckpoint && iteration === Math.ceil(maxIterations * 0.6) && iteration > 3) {
      const shouldContinue = await callbacks.onCheckpoint(
        `Reached iteration ${iteration} of ${maxIterations}. ${Math.round((estimatedTokens / maxTokens) * 100)}% context used.`,
        iteration,
        maxIterations - iteration,
      );
      if (!shouldContinue) {
        logger?.info('User stopped at checkpoint');
        callbacks.onText('\n\nStopped at checkpoint.');
        break;
      }
    }

    // Stream the next turn. Extracted into loop/streamTurn.ts.
    // streamOneTurn handles the per-event timeout, abort, and the
    // full event-type switch; resolveTurnContent runs post-stream
    // cleanup (strip repeated paragraphs, parse text tool calls).
    state.totalChars = totalChars;
    const requestTimeoutMs = config.requestTimeout * 1000;
    const rawTurn = await streamOneTurn(client, state, signal, callbacks, requestTimeoutMs);
    totalChars = state.totalChars;

    // Surface timeout as a user-visible notification before breaking.
    if (rawTurn.terminated === 'timeout') {
      const msg =
        `Request timed out after ${config.requestTimeout}s waiting for the model. ` +
        `The model may be loading or the prompt may be too large. ` +
        `You can increase sidecar.requestTimeout in settings.`;
      logger?.warn(msg);
      callbacks.onText(`\n\n⚠️ ${msg}\n`);
      break;
    }
    if (rawTurn.terminated === 'aborted') {
      break;
    }

    const resolved = resolveTurnContent(rawTurn, state, callbacks);
    const fullText = resolved.fullText;
    const pendingToolUses = resolved.pendingToolUses;
    const stopReason = resolved.stopReason;
    // Recompute iterTools for downstream usage (empty-turn tool-failure
    // heuristic still references it — will fold in with phase 3).
    const iterTools = state.approvalMode === 'plan' && iteration === 1 ? [] : tools;

    // If no tools to execute and no text, the model has nothing to do — stop.
    // Previously this used `continue` which could loop infinitely when
    // stripRepeatedContent emptied the response.
    if (pendingToolUses.length === 0) {
      // Only record a tool failure if the model's response looks like it
      // attempted to call tools but failed (contains tool-like syntax).
      // Normal text-only responses (answering questions) should NOT count
      // as failures — otherwise 3 Q&A turns would disable tools entirely.
      if (iterTools.length > 0 && fullText) {
        const looksLikeToolAttempt =
          fullText.includes('<function=') ||
          fullText.includes('<tool_call>') ||
          (fullText.includes('"name"') && fullText.includes('"arguments"'));
        if (looksLikeToolAttempt) {
          recordToolFailure(client.getModel());
        }
      }

      // Completion gate (empty-response branch) — extracted into
      // loop/gate.ts. Returns 'injected' when the gate pushed a
      // synthetic user message demanding verification; the loop
      // continues to give the agent another turn to verify. Returns
      // 'skip' in every other case (disabled, no edits to verify,
      // cap exhausted, or check came back clean).
      const gateOutcome = await maybeInjectCompletionGate(state, config, options, signal, callbacks);
      if (gateOutcome === 'injected') continue;

      break;
    }

    // Model used tools successfully — reset any failure tracking
    recordToolSuccess(client.getModel());

    // Per-iteration burst cap + cycle detection. Both extracted into
    // loop/cycleDetection.ts. Each returns `true` when the loop
    // should terminate; each is responsible for emitting the
    // user-visible explanation via callbacks.onText before returning.
    if (exceedsBurstCap(pendingToolUses, state, callbacks)) break;
    if (detectCycleAndBail(pendingToolUses, state, callbacks)) break;

    // Build + append the assistant message (text + tool_use blocks).
    // Extracted into loop/messageBuild.ts.
    pushAssistantMessage(state, fullText, pendingToolUses);

    // If the model wants to use tools, execute them and loop
    if ((stopReason === 'tool_use' || pendingToolUses.length > 0) && pendingToolUses.length > 0) {
      // Parallel tool execution with spawn_agent / delegate_task /
      // normal executeTool dispatch. Extracted into
      // loop/executeToolUses.ts. Returns a result array aligned 1:1
      // with pendingToolUses; rejected promises are promoted to
      // synthetic error tool_result blocks inside the helper so the
      // caller never has to worry about index alignment.
      //
      // state.totalChars is mutated directly by the helper for
      // spawn_agent sub-agents (parent pays for sub-agent tokens),
      // so we sync the local `totalChars` across the call.
      state.totalChars = totalChars;
      const toolResults = await executeToolUses(state, pendingToolUses, client, options, callbacks, signal);
      totalChars = state.totalChars;

      // Feed tool calls into the gate state so the next empty-response
      // turn can decide whether to inject a verification reprompt.
      // Extracted into loop/gate.ts.
      recordGateToolUses(state, pendingToolUses, toolResults);

      // Tool-use + tool-result token accounting and history append.
      // Extracted into loop/messageBuild.ts — the helper mutates
      // state.totalChars and state.messages directly, so we sync
      // `totalChars` across the call.
      state.totalChars = totalChars;
      accountToolTokens(state, pendingToolUses, toolResults);
      pushToolResultsMessage(state, toolResults);
      totalChars = state.totalChars;

      // Proactively compress after adding tool results so the next iteration
      // doesn't open over budget. Extracted into loop/compression.ts.
      state.totalChars = totalChars;
      maybeCompressPostTool(state);
      totalChars = state.totalChars;

      // Auto-fix on diagnostics — post-turn policy. Extracted into
      // loop/autoFix.ts. Honors the per-file retry budget stored on
      // state.autoFixRetriesByFile so a persistently broken file
      // can't loop the retry indefinitely.
      await applyAutoFix(state, pendingToolUses, config, callbacks);

      // Stub validator — scan written code for placeholder patterns
      // and reprompt on first hit. Extracted into loop/stubCheck.ts.
      // Sync stubFixRetries through state across the call so the
      // per-run attempt counter stays authoritative.
      state.stubFixRetries = stubFixRetries;
      applyStubCheck(state, pendingToolUses, callbacks);
      stubFixRetries = state.stubFixRetries;

      // Adversarial critic — post-turn policy. Extracted into
      // loop/criticHook.ts. The wrapper reads config.criticEnabled,
      // short-circuits on abort, and pushes the synthetic blocking
      // injection into history when the critic returns one.
      await applyCritic(state, client, config, pendingToolUses, toolResults, fullText, callbacks, signal);

      // Continue the loop — model will respond to tool results
      continue;
    }

    // In plan mode, return after first iteration so user can approve
    if (options.approvalMode === 'plan' && iteration === 1 && fullText) {
      callbacks.onPlanGenerated?.(fullText);
      break;
    }

    // Model finished (end_turn or max_tokens) — done
    break;
  }

  // Flush tool chain buffer at end of loop
  callbacks.onToolChainFlush?.();

  // Generate next-step suggestions based on what tools were used
  if (callbacks.onSuggestNextSteps && iteration > 1) {
    const suggestions = generateNextStepSuggestions(agentMessages);
    if (suggestions.length > 0) {
      callbacks.onSuggestNextSteps(suggestions);
    }
  }

  logger?.logDone(iteration);
  callbacks.onDone();
  return agentMessages;
}

// The adversarial critic runner (runCriticChecks, RunCriticOptions,
// buildCriticDiff, extractAgentIntent) lives in ./loop/criticHook.ts.
// runCriticChecks + RunCriticOptions are re-exported near the top of
// this file so critic.runner.test.ts keeps its existing import path.

/**
 * Analyze the completed agent conversation to suggest relevant follow-up actions.
 * Scans tool usage to infer what the agent did and what a natural next step would be.
 */
function generateNextStepSuggestions(messages: ChatMessage[]): string[] {
  const suggestions: string[] = [];
  const toolsUsed = new Set<string>();
  let hadErrors = false;
  let wroteFiles = false;
  let ranTests = false;

  for (const msg of messages) {
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolsUsed.add(block.name);
        if (block.name === 'write_file' || block.name === 'edit_file') wroteFiles = true;
        if (block.name === 'run_tests') ranTests = true;
      }
      if (block.type === 'tool_result' && block.is_error) hadErrors = true;
    }
  }

  if (wroteFiles && !ranTests) {
    suggestions.push('Run tests to verify the changes');
  }
  if (hadErrors) {
    suggestions.push('Review errors and retry the failed steps');
  }
  if (wroteFiles) {
    suggestions.push('Review the diff before committing');
  }
  if (toolsUsed.has('search_files') && !wroteFiles) {
    suggestions.push('Apply the findings — edit the relevant files');
  }

  return suggestions.slice(0, 3);
}

// parseTextToolCalls + stripRepeatedContent were extracted into
// ./loop/textParsing.ts. Re-exported at the top of this file so
// existing imports in loop.test.ts keep working.
