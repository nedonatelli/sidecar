import type { ChatMessage, ToolDefinition, ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { recordToolSuccess, recordToolFailure } from '../ollama/ollamaBackend.js';
import type { InlineEditFn } from './executor.js';
import type { ClarifyFn } from './tools.js';
import { getDiagnostics } from './tools.js';
import type { ToolRuntime } from './tools/runtime.js';
import { getConfig } from '../config/settings.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';
import {
  executeTool,
  type ApprovalMode,
  type ConfirmFn,
  type DiffPreviewFn,
  type StreamingDiffPreviewFn,
} from './executor.js';
import type { AgentLogger } from './logger.js';
import type { ChangeLog } from './changelog.js';
import type { MCPManager } from './mcpManager.js';
import { spawnSubAgent } from './subagent.js';
import { runLocalWorker } from './localWorker.js';
import { compressMessages, applyBudgetCompression, maybeCompressPostTool } from './loop/compression.js';
import { initLoopState } from './loop/state.js';
import { parseTextToolCalls, stripRepeatedContent } from './loop/textParsing.js';
import { streamOneTurn, resolveTurnContent } from './loop/streamTurn.js';
import { exceedsBurstCap, detectCycleAndBail } from './loop/cycleDetection.js';
import { pushAssistantMessage, pushToolResultsMessage, accountToolTokens } from './loop/messageBuild.js';
export { compressMessages, parseTextToolCalls, stripRepeatedContent };
import { buildStubReprompt } from './stubValidator.js';
import { recordToolCall as recordGateToolCall, checkCompletionGate, buildGateInjection } from './completionGate.js';
import type { PendingEditStore } from './pendingEdits.js';
import {
  CRITIC_SYSTEM_PROMPT,
  buildEditCriticPrompt,
  buildTestFailureCriticPrompt,
  parseCriticResponse,
  splitBySeverity,
  formatFindingsForChat,
  buildCriticInjection,
  type CriticTrigger,
  type CriticFinding,
} from './critic.js';
import { computeUnifiedDiff } from './diff.js';
import { workspace, Uri } from 'vscode';

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
  const { maxIterations, approvalMode, tools, logger, changelog, mcpManager, startTime } = state;
  const agentMessages = state.messages;
  const autoFixRetriesByFile = state.autoFixRetriesByFile;
  const criticInjectionsByFile = state.criticInjectionsByFile;
  const gateState = state.gateState;

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

  // Constants for the policy checks still inline in the iteration
  // body (gate, stub validator, critic). Will migrate out in phase 3.
  const MAX_STUB_RETRIES = 1;
  const MAX_GATE_INJECTIONS = 2;
  const MAX_CRITIC_INJECTIONS_PER_FILE = 2;
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

      // Completion gate: if the agent edited source files this turn but
      // never ran lint / tests for them, push a synthetic user message back
      // into the loop demanding verification. Skip in plan mode (which
      // intentionally returns after one turn for user approval) and when
      // the run was aborted.
      if (
        !signal.aborted &&
        options.approvalMode !== 'plan' &&
        config.completionGateEnabled !== false &&
        gateState.editedFiles.size > 0 &&
        gateState.gateInjections < MAX_GATE_INJECTIONS
      ) {
        const findings = await checkCompletionGate(gateState);
        if (findings.length > 0) {
          gateState.gateInjections++;
          const injection = buildGateInjection(findings, gateState.gateInjections, MAX_GATE_INJECTIONS);
          logger?.info(
            `Completion gate fired (#${gateState.gateInjections}/${MAX_GATE_INJECTIONS}): ${findings.length} unverified edit(s)`,
          );
          callbacks.onText('\n\n🔒 Verifying changes before completion...\n');
          agentMessages.push({
            role: 'user',
            content: [{ type: 'text' as const, text: injection }],
          });
          continue;
        }
      } else if (gateState.editedFiles.size > 0 && gateState.gateInjections >= MAX_GATE_INJECTIONS) {
        logger?.warn(
          `Completion gate exhausted (${MAX_GATE_INJECTIONS} injections) — allowing termination with unverified edits`,
        );
      }

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
      const toolResults: ToolResultContentBlock[] = [];

      // Execute tools in parallel for better performance
      const executionPromises = pendingToolUses.map(async (toolUse) => {
        // Handle spawn_agent specially — it needs the client and runtime context
        if (toolUse.name === 'spawn_agent') {
          const subResult = await spawnSubAgent(
            client,
            toolUse.input.task as string,
            toolUse.input.context as string | undefined,
            callbacks,
            signal,
            { logger, changelog, approvalMode, maxIterations: Math.min(maxIterations, 15), depth: options.depth || 0 },
          );
          // Charge sub-agent token usage to the parent's budget
          totalChars += subResult.charsConsumed;
          callbacks.onCharsConsumed?.(subResult.charsConsumed);
          const toolResult: ToolResultContentBlock = {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: subResult.output || '(no output)',
            is_error: !subResult.success,
          };
          return toolResult;
        }

        // Handle delegate_task — offload to a local Ollama worker.
        // The worker's token consumption does NOT count against the
        // orchestrator's paid-budget char counter. That's the entire
        // point of the tool: shift heavy I/O onto the free backend.
        if (toolUse.name === 'delegate_task') {
          const workerResult = await runLocalWorker(
            toolUse.input.task as string,
            toolUse.input.context as string | undefined,
            callbacks,
            signal,
            { logger, changelog, mcpManager, depth: options.depth || 0 },
          );
          const toolResult: ToolResultContentBlock = {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: workerResult.output,
            is_error: !workerResult.success,
          };
          return toolResult;
        }

        const result = await executeTool(toolUse, {
          approvalMode,
          changelog,
          mcpManager,
          logger,
          confirmFn: options.confirmFn,
          diffPreviewFn: options.diffPreviewFn,
          executorContext: {
            onOutput: (chunk) => callbacks.onToolOutput?.(toolUse.name, chunk, toolUse.id),
            signal,
            clarifyFn: options.clarifyFn,
            modeToolPermissions: options.modeToolPermissions,
            toolRuntime: options.toolRuntime,
          },
          inlineEditFn: options.inlineEditFn,
          streamingDiffPreviewFn: options.streamingDiffPreviewFn,
          pendingEdits: options.pendingEdits,
        });
        logger?.logToolResult(toolUse.name, result.content, result.is_error || false);

        // Record tool use in memory — both successes and failures
        const inputStr = typeof toolUse.input === 'object' ? JSON.stringify(toolUse.input) : String(toolUse.input);
        if (!result.is_error) {
          callbacks.onMemory?.(
            'pattern',
            `tool:${toolUse.name}`,
            `${toolUse.name} works well with args like: ${inputStr.slice(0, 100)}`,
          );
        } else {
          callbacks.onMemory?.(
            'failure',
            `tool:${toolUse.name}`,
            `${toolUse.name} can fail when: ${result.content.slice(0, 120)}`,
          );
        }
        callbacks.onToolChainRecord?.(toolUse.name, !result.is_error);

        callbacks.onToolResult(toolUse.name, result.content, result.is_error || false, toolUse.id);
        return result;
      });

      // Execute all tools in parallel — use allSettled so one failure
      // doesn't abort the others
      const settled = await Promise.allSettled(executionPromises);
      for (let idx = 0; idx < settled.length; idx++) {
        const outcome = settled[idx];
        if (outcome.status === 'fulfilled') {
          toolResults.push(outcome.value);
        } else {
          // Promise rejected — turn it into an error tool result
          const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: pendingToolUses[idx].id,
            content: `Internal error: ${errMsg}`,
            is_error: true,
          });
          logger?.warn(`Tool ${pendingToolUses[idx].name} threw: ${errMsg}`);
          callbacks.onToolResult(pendingToolUses[idx].name, `Internal error: ${errMsg}`, true, pendingToolUses[idx].id);
        }
      }

      // Feed successful tool calls into the completion gate so it can track
      // which files were edited and which verification commands have run.
      for (let idx = 0; idx < pendingToolUses.length; idx++) {
        const tr = toolResults[idx];
        if (tr) recordGateToolCall(gateState, pendingToolUses[idx], tr);
      }

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

      // Auto-fix: check for errors after file writes and feed them back
      if (config.autoFixOnFailure) {
        const writtenFiles = pendingToolUses
          .filter((tu) => tu.name === 'write_file' || tu.name === 'edit_file')
          .map((tu) => (tu.input.path || tu.input.file_path) as string)
          .filter(Boolean);

        // Only consider files whose per-file retry budget hasn't been exhausted
        const eligibleFiles = writtenFiles.filter((f) => (autoFixRetriesByFile.get(f) || 0) < config.autoFixMaxRetries);

        if (eligibleFiles.length > 0) {
          // Small delay to let VS Code language services update diagnostics
          await new Promise((r) => setTimeout(r, 500));

          const diagResults = await Promise.allSettled(eligibleFiles.map((f) => getDiagnostics({ path: f })));
          const fileErrors: { file: string; errors: string }[] = [];
          for (let i = 0; i < eligibleFiles.length; i++) {
            const r = diagResults[i];
            if (r.status === 'fulfilled' && r.value.includes('[Error]')) {
              fileErrors.push({ file: eligibleFiles[i], errors: r.value });
            }
          }

          if (fileErrors.length > 0) {
            // Increment per-file retry counter
            for (const { file } of fileErrors) {
              autoFixRetriesByFile.set(file, (autoFixRetriesByFile.get(file) || 0) + 1);
            }
            const attemptSummary = fileErrors
              .map(({ file }) => `${file} (${autoFixRetriesByFile.get(file)}/${config.autoFixMaxRetries})`)
              .join(', ');
            callbacks.onText(`\n⚠️ Auto-fixing errors: ${attemptSummary}\n`);
            agentMessages.push({
              role: 'user',
              content: [
                {
                  type: 'text' as const,
                  text: `Errors detected after your edits. Please fix them:\n${fileErrors.map((fe) => fe.errors).join('\n')}`,
                },
              ],
            });
          }
        }
      }

      // Stub validation: scan written code for placeholder patterns
      // and reprompt the model to finish the implementation.
      if (stubFixRetries < MAX_STUB_RETRIES) {
        const stubReprompt = buildStubReprompt(pendingToolUses);
        if (stubReprompt) {
          stubFixRetries++;
          logger?.info(
            `Stub validator: found placeholders, reprompting (attempt ${stubFixRetries}/${MAX_STUB_RETRIES})`,
          );
          callbacks.onText('\n⚠️ Incomplete code detected — requesting full implementation...\n');
          agentMessages.push({
            role: 'user',
            content: [{ type: 'text' as const, text: stubReprompt }],
          });
        }
      }

      // Adversarial critic: fire an independent LLM call whose job is to
      // attack the most recent edits (and root-cause any test failures).
      // High-severity findings inject a synthetic user message forcing the
      // agent to address them before the turn can finish; low-severity
      // findings surface as chat annotations only. Disabled by default.
      if (config.criticEnabled && !signal.aborted) {
        const criticInjection = await runCriticChecks({
          client,
          config,
          pendingToolUses,
          toolResults,
          changelog,
          fullText,
          callbacks,
          logger,
          signal,
          criticInjectionsByFile,
          maxPerFile: MAX_CRITIC_INJECTIONS_PER_FILE,
        });
        if (criticInjection) {
          agentMessages.push({
            role: 'user',
            content: [{ type: 'text' as const, text: criticInjection }],
          });
        }
      }

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

// ---------------------------------------------------------------------------
// Adversarial critic runner
// ---------------------------------------------------------------------------

/**
 * Options for `runCriticChecks`. Exported so the integration test at
 * critic.runner.test.ts can build fixtures without dragging in a full
 * runAgentLoop simulation — every dependency the runner touches comes
 * in through this interface.
 */
export interface RunCriticOptions {
  client: SideCarClient;
  config: ReturnType<typeof getConfig>;
  pendingToolUses: ToolUseContentBlock[];
  toolResults: ToolResultContentBlock[];
  changelog: ChangeLog | undefined;
  fullText: string;
  callbacks: AgentCallbacks;
  logger: AgentLogger | undefined;
  signal: AbortSignal;
  criticInjectionsByFile: Map<string, number>;
  maxPerFile: number;
}

/**
 * Run the adversarial critic against the current iteration's edits and any
 * failed test runs. Returns a synthetic user-message string if high-severity
 * findings should block the turn, or null to let the loop continue normally.
 *
 * The critic is opportunistic: any exception (network, parse error, bad
 * model response) is logged and swallowed so the main loop can proceed.
 * Findings are always surfaced to the chat via `onText` regardless of
 * whether they block — users want to see the review even when it's passive.
 *
 * Exported for test access. Not part of the public loop API — the in-loop
 * call site at the top of the file is the one that matters for runtime.
 */
export async function runCriticChecks(opts: RunCriticOptions): Promise<string | null> {
  const {
    client,
    config,
    pendingToolUses,
    toolResults,
    changelog,
    fullText,
    callbacks,
    logger,
    signal,
    criticInjectionsByFile,
    maxPerFile,
  } = opts;

  // Build the set of triggers: one per successful edit, plus one per
  // failed run_tests. A turn can have multiple triggers — we fire the
  // critic on each independently so per-trigger findings are traceable.
  const triggers: CriticTrigger[] = [];

  // --- Edit triggers ---
  const editedFiles: { filePath: string; diff: string }[] = [];
  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    const tr = toolResults[i];
    if (!tr || tr.is_error) continue;
    if (tu.name !== 'write_file' && tu.name !== 'edit_file') continue;

    const filePath = (tu.input.path ?? tu.input.file_path) as string | undefined;
    if (!filePath) continue;

    const diff = await buildCriticDiff(filePath, changelog);
    if (!diff) continue;

    editedFiles.push({ filePath, diff });
    triggers.push({
      kind: 'edit',
      filePath,
      diff,
      intent: extractAgentIntent(fullText),
    });
  }

  // --- Test-failure triggers ---
  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    const tr = toolResults[i];
    if (!tr || !tr.is_error) continue;
    if (tu.name !== 'run_tests') continue;

    triggers.push({
      kind: 'test_failure',
      testOutput: tr.content,
      recentEdits: editedFiles.slice(),
    });
  }

  if (triggers.length === 0) return null;

  // --- Fire the critic for each trigger, collecting findings ---
  const highFindings: CriticFinding[] = [];
  const blockedFiles = new Set<string>();

  for (const trigger of triggers) {
    if (signal.aborted) return null;

    // Per-file injection cap: skip edit triggers whose file has already
    // been blocked twice this turn. Test-failure triggers aren't capped
    // because there's no single "file" to scope them to.
    if (trigger.kind === 'edit') {
      const used = criticInjectionsByFile.get(trigger.filePath) ?? 0;
      if (used >= maxPerFile) {
        logger?.info(`Critic: skipping ${trigger.filePath} — cap reached (${used}/${maxPerFile})`);
        continue;
      }
    }

    let raw: string;
    try {
      const userPrompt =
        trigger.kind === 'edit' ? buildEditCriticPrompt(trigger) : buildTestFailureCriticPrompt(trigger);
      raw = await client.completeWithOverrides(
        CRITIC_SYSTEM_PROMPT,
        [{ role: 'user', content: userPrompt }],
        config.criticModel || undefined,
        1024,
        signal,
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return null;
      logger?.warn(`Critic call failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const parsed = parseCriticResponse(raw);
    if (parsed.malformed) {
      logger?.warn(`Critic returned malformed response; skipping this trigger`);
      continue;
    }
    if (parsed.explicitlyClean || parsed.findings.length === 0) continue;

    const { high } = splitBySeverity(parsed.findings);

    // Surface every finding (high + low) to the chat as an annotation.
    // Users want visibility even for passive (non-blocking) reviews.
    const chatText = formatFindingsForChat(parsed.findings, trigger);
    if (chatText) callbacks.onText(chatText);

    // High-severity findings accumulate into the blocking injection iff
    // the config says we should block on them.
    if (config.criticBlockOnHighSeverity && high.length > 0) {
      highFindings.push(...high);
      if (trigger.kind === 'edit') blockedFiles.add(trigger.filePath);
    }
  }

  if (highFindings.length === 0) return null;

  // Increment the per-file injection counter for every file that will be
  // blocked this turn so successive iterations can't re-block indefinitely.
  for (const filePath of blockedFiles) {
    criticInjectionsByFile.set(filePath, (criticInjectionsByFile.get(filePath) ?? 0) + 1);
  }

  // Use the max per-file attempt across blocked files as the "attempt"
  // number in the injection banner — gives the model a sense of urgency
  // on the final retry.
  let attempt = 1;
  for (const filePath of blockedFiles) {
    attempt = Math.max(attempt, criticInjectionsByFile.get(filePath) ?? 1);
  }

  logger?.info(
    `Critic: blocking with ${highFindings.length} high-severity finding(s) across ${blockedFiles.size} file(s), attempt ${attempt}/${maxPerFile}`,
  );

  return buildCriticInjection(highFindings, attempt, maxPerFile);
}

/**
 * Compute a unified diff for a file that was just written or edited,
 * using the ChangeLog's pre-edit snapshot as the baseline. Falls back to
 * "null → current" (showing the full file as an addition) when no
 * snapshot exists — the critic still sees the content, just without a
 * proper before/after.
 */
async function buildCriticDiff(filePath: string, changelog: ChangeLog | undefined): Promise<string | null> {
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return null;

  let currentContent: string | null = null;
  try {
    const bytes = await workspace.fs.readFile(Uri.joinPath(rootUri, filePath));
    currentContent = Buffer.from(bytes).toString('utf-8');
  } catch {
    return null; // file disappeared mid-turn
  }

  const snapshot = changelog?.getChanges().find((c) => c.filePath === filePath);
  const originalContent = snapshot?.originalContent ?? null;

  return computeUnifiedDiff(filePath, originalContent, currentContent);
}

/**
 * Extract the agent's stated intent from its most recent text emission.
 * Grabs the first 500 chars of non-empty text so the critic sees what
 * the agent said it was trying to do without burning tokens on the full
 * stream-of-consciousness.
 */
function extractAgentIntent(fullText: string): string | undefined {
  const trimmed = fullText.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}

// compressMessages was extracted into ./loop/compression.ts and is
// re-exported below so the existing tests in loop.test.ts keep working
// without a coordinated import rewrite.

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
