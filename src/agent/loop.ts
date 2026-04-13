import type {
  ChatMessage,
  ContentBlock,
  StreamEvent,
  ToolDefinition,
  ToolUseContentBlock,
  ToolResultContentBlock,
} from '../ollama/types.js';
import { getContentLength } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { recordToolSuccess, recordToolFailure } from '../ollama/ollamaBackend.js';
import type { InlineEditFn } from './executor.js';
import type { ClarifyFn } from './tools.js';
import { getToolDefinitions, getDiagnostics } from './tools.js';
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
import { ConversationSummarizer } from './conversationSummarizer.js';
import { ToolResultCompressor } from './toolResultCompressor.js';
import { buildStubReprompt } from './stubValidator.js';
import {
  createGateState,
  recordToolCall as recordGateToolCall,
  checkCompletionGate,
  buildGateInjection,
} from './completionGate.js';
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
}

const DEFAULT_MAX_ITERATIONS = 25;
export const MAX_AGENT_DEPTH = 3;

export async function runAgentLoop(
  client: SideCarClient,
  messages: ChatMessage[],
  callbacks: AgentCallbacks,
  signal: AbortSignal,
  options: AgentOptions = {},
): Promise<ChatMessage[]> {
  const maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
  const approvalMode = options.approvalMode || 'cautious';
  const logger = options.logger;
  const changelog = options.changelog;
  const mcpManager = options.mcpManager;
  const maxTokens = options.maxTokens || 100_000;
  const tools = getToolDefinitions(mcpManager);
  let iteration = 0;
  // Per-file auto-fix retry counter — resets for each new file write so a buggy
  // file doesn't burn the budget for unrelated subsequent writes.
  const autoFixRetriesByFile = new Map<string, number>();
  let stubFixRetries = 0;
  const MAX_STUB_RETRIES = 1;
  const startTime = Date.now();

  // Cycle detection: track recent tool calls to detect stuck loops.
  // CYCLE_WINDOW must hold at least 2 full cycles of the longest pattern we want to detect
  // and at least MIN_IDENTICAL_REPEATS to evaluate the same-call-in-a-row case.
  const recentToolCalls: string[] = [];
  const CYCLE_WINDOW = 8;
  const MAX_CYCLE_LEN = 4;
  const MIN_IDENTICAL_REPEATS = 4;

  // Completion gate: tracks edits / lint / test runs across the turn and
  // refuses to let the loop terminate until the agent has verified its work.
  // See completionGate.ts for the rule set.
  const gateState = createGateState();
  const MAX_GATE_INJECTIONS = 2;

  // Adversarial critic: per-file cap on blocking injections so the agent
  // can't be trapped in an infinite critic loop if the model can't address
  // a particular finding. Matches the completion-gate pattern.
  const criticInjectionsByFile = new Map<string, number>();
  const MAX_CRITIC_INJECTIONS_PER_FILE = 2;

  // Work with a copy of messages
  const agentMessages = [...messages];

  // Initialize totalChars from existing conversation history so the
  // compression threshold accounts for all context, not just new output.
  // Uses the shared getContentLength helper so tool_use blocks and tool
  // inputs are counted consistently with the rest of the codebase.
  let totalChars = 0;
  for (const msg of agentMessages) {
    totalChars += getContentLength(msg.content);
  }

  while (iteration < maxIterations) {
    iteration++;
    if (signal.aborted) {
      logger?.logAborted();
      break;
    }
    let estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);

    // Compress context at 70% of budget (or when already over) to extend the loop.
    // Both strategies are applied: summarization replaces old turns, compression
    // truncates large tool results. Running both maximises freed space.
    if (estimatedTokens > maxTokens * 0.7) {
      // 1. Summarize old turns
      const summarizer = new ConversationSummarizer(client);
      const summarized = await summarizer.summarize(agentMessages, {
        keepRecentTurns: 2,
        minCharsToSave: 2000,
        maxSummaryLength: 800,
        summaryTimeoutMs: 5000,
      });
      if (summarized.freedChars > 0) {
        agentMessages.splice(0, agentMessages.length, ...summarized.messages);
        totalChars -= summarized.freedChars;
        logger?.info(
          `Conversation summarized: ${summarized.metadata.turnsSummarized}/${summarized.metadata.turnsCount} turns compressed, freed ${summarized.freedChars} chars`,
        );
      }

      // 2. Always compress tool results too — they target different content
      const compressed = compressMessages(agentMessages);
      if (compressed) {
        logger?.info(`Context compressed: removed ${compressed} chars of old tool results`);
        totalChars -= compressed;
      }

      estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
    }

    // Hard stop only if compaction couldn't bring us under budget
    if (estimatedTokens > maxTokens) {
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

    // Stream response from model
    const assistantContent: ContentBlock[] = [];
    let fullText = '';
    const pendingToolUses: ToolUseContentBlock[] = [];
    let stopReason = 'end_turn';

    // In plan mode, first iteration runs without tools to generate a plan
    const iterTools = options.approvalMode === 'plan' && iteration === 1 ? [] : tools;

    // Request timeout — abort if no stream events arrive within the window.
    // We use Promise.race on each .next() call rather than relying on
    // AbortSignal propagation through fetch, which is unreliable in Node.
    const requestTimeoutMs = config.requestTimeout * 1000;

    const stream = client.streamChat(agentMessages, signal, iterTools);
    const iter = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        if (signal.aborted) break;

        // Race the next stream event against the timeout.
        // Clear the timer when next() wins so we don't leak timers and keep the
        // event loop alive longer than needed.
        let result: IteratorResult<StreamEvent>;
        if (requestTimeoutMs > 0) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const next = iter.next();
          const timeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('__REQUEST_TIMEOUT__')), requestTimeoutMs);
          });
          try {
            result = await Promise.race([next, timeout]);
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }
        } else {
          result = await iter.next();
        }

        if (result.done) break;
        const event = result.value;

        switch (event.type) {
          case 'text':
            fullText += event.text;
            totalChars += event.text.length;
            callbacks.onCharsConsumed?.(event.text.length);
            callbacks.onText(event.text);
            break;
          case 'thinking':
            totalChars += event.thinking.length;
            callbacks.onCharsConsumed?.(event.thinking.length);
            callbacks.onThinking?.(event.thinking);
            break;
          case 'warning':
            callbacks.onText(`\n⚠️ ${event.message}\n`);
            break;
          case 'tool_use':
            pendingToolUses.push(event.toolUse);
            logger?.logToolCall(event.toolUse.name, event.toolUse.input);
            callbacks.onToolCall(event.toolUse.name, event.toolUse.input, event.toolUse.id);
            break;
          case 'stop':
            stopReason = event.stopReason;
            break;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === '__REQUEST_TIMEOUT__') {
        const msg =
          `Request timed out after ${config.requestTimeout}s waiting for the model. ` +
          `The model may be loading or the prompt may be too large. ` +
          `You can increase sidecar.requestTimeout in settings.`;
        logger?.warn(msg);
        callbacks.onText(`\n\n⚠️ ${msg}\n`);
        // Best-effort cleanup — the generator may not support return()
        try {
          iter.return?.(undefined);
        } catch {
          /* stream cleanup is best-effort */
        }
        break;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        break;
      }
      throw err;
    }

    // Strip repeated content from the model's output.
    // Some models echo blocks of text from earlier in the conversation.
    if (fullText) {
      fullText = stripRepeatedContent(fullText, agentMessages);
    }

    // If no structured tool calls came through, try parsing text-based tool calls
    if (pendingToolUses.length === 0 && fullText) {
      const parsed = parseTextToolCalls(fullText, tools);
      for (const tu of parsed) {
        pendingToolUses.push(tu);
        logger?.logToolCall(tu.name, tu.input);
        callbacks.onToolCall(tu.name, tu.input, tu.id);
      }
      if (parsed.length > 0) {
        stopReason = 'tool_use';
      }
    }

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

    // Cycle detection: hash the tool calls and check for repetition.
    // Length-1 (same call repeated) requires MIN_IDENTICAL_REPEATS consecutive
    // hits before bailing — agents legitimately re-run a tool to verify after
    // an edit, retry tests after a fix, or refine inputs based on prior output.
    // Length 2..MAX_CYCLE_LEN still trips after two full cycles since A,B,A,B
    // is a much clearer signal of a stuck loop.
    const callSignature = pendingToolUses.map((tu) => `${tu.name}:${JSON.stringify(tu.input)}`).join('|');
    recentToolCalls.push(callSignature);
    if (recentToolCalls.length > CYCLE_WINDOW) {
      recentToolCalls.shift();
    }
    let cycleDetected = false;
    if (recentToolCalls.length >= MIN_IDENTICAL_REPEATS) {
      const lastN = recentToolCalls.slice(-MIN_IDENTICAL_REPEATS);
      if (lastN.every((v) => v === lastN[0])) {
        cycleDetected = true;
        logger?.warn(
          `Agent loop cycle detected (${MIN_IDENTICAL_REPEATS} identical calls) — ${callSignature.slice(0, 100)}`,
        );
        callbacks.onText(`\n\n⚠️ Agent stopped: same tool call repeated ${MIN_IDENTICAL_REPEATS} times in a row.\n`);
      }
    }
    if (!cycleDetected) {
      for (let len = 2; len <= MAX_CYCLE_LEN && len * 2 <= recentToolCalls.length; len++) {
        const tail = recentToolCalls.slice(-len);
        const prev = recentToolCalls.slice(-2 * len, -len);
        if (tail.length === prev.length && tail.every((v, i) => v === prev[i])) {
          cycleDetected = true;
          logger?.warn(`Agent loop cycle detected (length ${len}) — ${callSignature.slice(0, 100)}`);
          callbacks.onText(`\n\n⚠️ Agent stopped: detected repeating tool call pattern of length ${len}.\n`);
          break;
        }
      }
    }
    if (cycleDetected) break;

    // Build the assistant message content
    if (fullText) {
      assistantContent.push({ type: 'text', text: fullText });
    }
    for (const tu of pendingToolUses) {
      assistantContent.push(tu);
    }

    // Add assistant message to history
    if (assistantContent.length > 0) {
      agentMessages.push({
        role: 'assistant',
        content: assistantContent,
      });
    }

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

      // Count tool call and result tokens toward the budget
      for (const tu of pendingToolUses) {
        totalChars += tu.name.length;
        for (const v of Object.values(tu.input)) {
          totalChars += typeof v === 'string' ? v.length : String(v).length;
        }
      }
      for (const tr of toolResults) {
        totalChars += tr.content.length;
      }

      // Add tool results as a user message (Anthropic API format)
      agentMessages.push({
        role: 'user',
        content: toolResults,
      });

      // Proactively compress after adding tool results so the next iteration
      // doesn't open over budget (tool results can be very large).
      const postToolTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
      if (postToolTokens > maxTokens * 0.7) {
        const compressed = compressMessages(agentMessages);
        if (compressed) {
          totalChars -= compressed;
          logger?.info(`Post-tool compression: removed ${compressed} chars`);
        }
      }

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

interface RunCriticOptions {
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
 */
async function runCriticChecks(opts: RunCriticOptions): Promise<string | null> {
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

/**
 * Compress old tool results in the message history to free up context space.
 * Uses a tiered approach: messages further from the current iteration get
 * compressed more aggressively.
 * Returns the number of characters freed.
 */
export function compressMessages(messages: ChatMessage[]): number {
  let freed = 0;
  const len = messages.length;
  const compressor = new ToolResultCompressor();

  for (let i = 0; i < len; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;

    // Distance from the end determines compression level
    const distFromEnd = len - 1 - i;
    // Last 2 messages: untouched. 2-6: light. 6+: aggressive.
    let maxLen: number;
    if (distFromEnd < 2)
      continue; // keep recent messages intact
    else if (distFromEnd < 6) maxLen = 1000;
    else maxLen = 200;

    const newContent: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.content.length > maxLen) {
        const original = block.content.length;
        // Use intelligent compression instead of dumb truncation
        const compressionResult = compressor.compress(block.content, maxLen);
        const compressed = compressionResult.content;
        newContent.push({ ...block, content: compressed });
        freed += original - compressed.length;
      } else if (block.type === 'thinking' && distFromEnd >= 8) {
        // Drop old thinking blocks to save space
        freed += block.thinking.length;
      } else {
        newContent.push(block);
      }
    }
    messages[i] = { ...msg, content: newContent };
  }

  return freed;
}

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

/**
 * Parse tool calls from model text output when the model doesn't use structured tool_use blocks.
 * Handles common formats:
 *   - <function=name><parameter=key>value</parameter></function>
 *   - <tool_call>{"name":"...","arguments":{...}}</tool_call>
 *   - ```json\n{"name":"...","arguments":{...}}\n```
 */
export function parseTextToolCalls(text: string, tools: ToolDefinition[]): ToolUseContentBlock[] {
  const toolNames = new Set(tools.map((t) => t.name));
  const results: ToolUseContentBlock[] = [];
  let idCounter = 0;

  // Single combined regex matches all three patterns in one pass.
  // Groups: (1) function=name, (2) function body,
  //         (3) tool_call body, (4) json code fence body
  const combined =
    /<function=(\w+)>([\s\S]*?)<\/function>|<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/g;

  // Track which pattern type matched first (for priority: fn > tool_call > json)
  let firstType: 'fn' | 'tc' | 'json' | null = null;
  let match;

  while ((match = combined.exec(text)) !== null) {
    // Pattern 1: <function=name><parameter=key>value</parameter></function>
    if (match[1] !== undefined) {
      if (firstType === null) firstType = 'fn';
      if (firstType !== 'fn') continue; // stick with first pattern type found
      const name = match[1];
      if (!toolNames.has(name)) continue;
      const body = match[2];
      const input: Record<string, unknown> = {};
      const paramPattern = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
      let pm;
      while ((pm = paramPattern.exec(body)) !== null) {
        input[pm[1]] = pm[2].trim();
      }
      results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
    }
    // Pattern 2: <tool_call>JSON</tool_call>
    else if (match[3] !== undefined) {
      if (firstType === null) firstType = 'tc';
      if (firstType !== 'tc') continue;
      try {
        const parsed = JSON.parse(match[3]);
        const name = parsed.name || parsed.function?.name;
        const args = parsed.arguments || parsed.function?.arguments || parsed.parameters || {};
        if (name && toolNames.has(name)) {
          const input = typeof args === 'string' ? JSON.parse(args) : args;
          results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
        }
      } catch {
        /* skip malformed */
      }
    }
    // Pattern 3: ```json\n{...}\n```
    else if (match[4] !== undefined) {
      if (firstType === null) firstType = 'json';
      if (firstType !== 'json') continue;
      try {
        const parsed = JSON.parse(match[4]);
        const name = parsed.name || parsed.tool || parsed.function;
        const args = parsed.arguments || parsed.parameters || parsed.input || {};
        if (name && typeof name === 'string' && toolNames.has(name)) {
          const input = typeof args === 'string' ? JSON.parse(args) : args;
          results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
        }
      } catch {
        /* skip malformed */
      }
    }
  }

  return results;
}

/**
 * Strip blocks of text that the model is repeating verbatim from earlier
 * assistant messages in the conversation. This prevents the model from
 * echoing stale content (e.g., commit summaries, status updates) that
 * got stuck in the conversation history.
 *
 * Only strips blocks of 200+ characters to avoid false positives.
 * Skips content inside code blocks (``` fences) to avoid breaking code examples.
 */
export function stripRepeatedContent(text: string, messages: ChatMessage[]): string {
  // Build a Set of substantial paragraphs from previous assistant messages for O(1) lookup.
  const seenParagraphs = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const texts: string[] = [];
    if (typeof msg.content === 'string') {
      texts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text);
        }
      }
    }
    for (const t of texts) {
      for (const paragraph of t.split(/\n\n+/)) {
        const trimmed = paragraph.trim();
        if (trimmed.length >= 200) {
          seenParagraphs.add(trimmed);
        }
      }
    }
  }

  if (seenParagraphs.size === 0) return text;

  // Split the new text into paragraphs, preserving code blocks intact.
  // Code blocks should never be stripped even if they match previous content.
  const parts: string[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastEnd = 0;
  let cbMatch;
  while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
    if (cbMatch.index > lastEnd) {
      parts.push(text.slice(lastEnd, cbMatch.index));
    }
    // Mark code blocks with a sentinel so we skip them during filtering
    parts.push('\0CB\0' + cbMatch[0]);
    lastEnd = cbMatch.index + cbMatch[0].length;
  }
  if (lastEnd < text.length) {
    parts.push(text.slice(lastEnd));
  }

  // Filter paragraphs in non-code-block segments
  const filtered: string[] = [];
  for (const part of parts) {
    if (part.startsWith('\0CB\0')) {
      filtered.push(part.slice(4)); // Remove sentinel, keep code block
      continue;
    }
    const paragraphs = part.split(/\n\n+/);
    const kept = paragraphs.filter((p) => !seenParagraphs.has(p.trim()));
    filtered.push(kept.join('\n\n'));
  }

  // Clean up leftover whitespace from removals
  return filtered
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
