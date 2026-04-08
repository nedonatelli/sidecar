import type {
  ChatMessage,
  ContentBlock,
  StreamEvent,
  ToolDefinition,
  ToolUseContentBlock,
  ToolResultContentBlock,
} from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { recordToolSuccess, recordToolFailure } from '../ollama/ollamaBackend.js';
import { getToolDefinitions, getDiagnostics } from './tools.js';
import { getConfig } from '../config/settings.js';
import { executeTool, type ApprovalMode, type ConfirmFn, type DiffPreviewFn } from './executor.js';
import type { AgentLogger } from './logger.js';
import type { ChangeLog } from './changelog.js';
import type { MCPManager } from './mcpManager.js';
import { spawnSubAgent } from './subagent.js';
import { ConversationSummarizer } from './conversationSummarizer.js';
import { ToolResultCompressor } from './toolResultCompressor.js';

export interface AgentCallbacks {
  onText: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>, id: string) => void;
  onToolResult: (name: string, result: string, isError: boolean, id: string) => void;
  /** Streaming output from long-running tools (e.g., shell commands). */
  onToolOutput?: (name: string, chunk: string, id?: string) => void;
  onPlanGenerated?: (plan: string) => void;
  onIterationStart?: (info: {
    iteration: number;
    maxIterations: number;
    elapsedMs: number;
    estimatedTokens: number;
    messageCount: number;
    messagesRemaining: number;
    atCapacity: boolean;
  }) => void;
  onDone: () => void;
}

export interface AgentOptions {
  maxIterations?: number;
  maxTokens?: number;
  approvalMode?: ApprovalMode;
  planMode?: boolean;
  logger?: AgentLogger;
  changelog?: ChangeLog;
  mcpManager?: MCPManager;
  confirmFn?: ConfirmFn;
  diffPreviewFn?: DiffPreviewFn;
}

const DEFAULT_MAX_ITERATIONS = 25;

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
  let totalChars = 0;
  let autoFixRetries = 0;
  const startTime = Date.now();

  // Cycle detection: track recent tool calls to detect stuck loops
  const recentToolCalls: string[] = [];
  const CYCLE_WINDOW = 4;

  // Work with a copy of messages
  const agentMessages = [...messages];

  while (iteration < maxIterations) {
    iteration++;
    if (signal.aborted) {
      logger?.logAborted();
      break;
    }
    // Check token budget (estimate: ~3.5 chars per token for typical LLM tokenizers)
    const estimatedTokens = Math.ceil(totalChars / 3.5);
    if (estimatedTokens > maxTokens) {
      logger?.warn(`Token budget exceeded: ~${estimatedTokens} tokens > ${maxTokens} limit`);
      callbacks.onText(`\n\n⚠️ Agent stopped: token budget exceeded (~${estimatedTokens} tokens).`);
      break;
    }

    // Compress context at 70% of budget to extend the loop
    if (estimatedTokens > maxTokens * 0.7) {
      // First, try conversation summarization for better context retention
      const summarizer = new ConversationSummarizer(client);
      const summarized = await summarizer.summarize(agentMessages, {
        keepRecentTurns: 4,
        minCharsToSave: 2000,
        maxSummaryLength: 800,
        summaryTimeoutMs: 5000, // Don't block too long
      });

      if (summarized.freedChars > 0) {
        // Summarization was successful — use the result
        agentMessages.splice(0, agentMessages.length, ...summarized.messages);
        totalChars -= summarized.freedChars;
        logger?.info(
          `Conversation summarized: ${summarized.metadata.turnsSummarized}/${summarized.metadata.turnsCount} turns compressed, freed ${summarized.freedChars} chars`,
        );
      } else {
        // Summarization didn't help (not enough old turns or too small) — fall back to truncation
        const compressed = compressMessages(agentMessages);
        if (compressed) {
          logger?.info(`Context compressed: removed ${compressed} chars of old tool results`);
          totalChars -= compressed;
        }
      }
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

    // Stream response from model
    const assistantContent: ContentBlock[] = [];
    let fullText = '';
    const pendingToolUses: ToolUseContentBlock[] = [];
    let stopReason = 'end_turn';

    // In plan mode, first iteration runs without tools to generate a plan
    const iterTools = options.planMode && iteration === 1 ? [] : tools;

    // Request timeout — abort if no stream events arrive within the window.
    // We use Promise.race on each .next() call rather than relying on
    // AbortSignal propagation through fetch, which is unreliable in Node.
    const requestTimeoutMs = config.requestTimeout * 1000;

    const stream = client.streamChat(agentMessages, signal, iterTools);
    const iter = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        if (signal.aborted) break;

        // Race the next stream event against the timeout
        let result: IteratorResult<StreamEvent>;
        if (requestTimeoutMs > 0) {
          const next = iter.next();
          const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('__REQUEST_TIMEOUT__')), requestTimeoutMs);
          });
          result = await Promise.race([next, timeout]);
        } else {
          result = await iter.next();
        }

        if (result.done) break;
        const event = result.value;

        switch (event.type) {
          case 'text':
            fullText += event.text;
            totalChars += event.text.length;
            callbacks.onText(event.text);
            break;
          case 'thinking':
            totalChars += event.thinking.length;
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
      // Track that tools were available but not used — helps auto-detect
      // models that don't actually support tool calling.
      if (iterTools.length > 0 && fullText) {
        recordToolFailure(client.getModel());
      }
      break;
    }

    // Model used tools successfully — reset any failure tracking
    recordToolSuccess(client.getModel());

    // Cycle detection: hash the tool calls and check for repetition
    const callSignature = pendingToolUses.map((tu) => `${tu.name}:${JSON.stringify(tu.input)}`).join('|');
    recentToolCalls.push(callSignature);
    if (recentToolCalls.length > CYCLE_WINDOW) {
      recentToolCalls.shift();
    }
    if (recentToolCalls.length >= 2) {
      const last = recentToolCalls[recentToolCalls.length - 1];
      const prev = recentToolCalls[recentToolCalls.length - 2];
      if (last === prev) {
        logger?.warn(`Agent loop cycle detected: same tool call repeated — ${callSignature.slice(0, 100)}`);
        callbacks.onText('\n\n⚠️ Agent stopped: detected repeated tool call (possible loop).\n');
        break;
      }
    }

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
            { logger, changelog, approvalMode, maxIterations: Math.min(maxIterations, 15) },
          );
          const toolResult: ToolResultContentBlock = {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: subResult.output || '(no output)',
            is_error: !subResult.success,
          };
          return toolResult;
        }

        const result = await executeTool(
          toolUse,
          approvalMode,
          changelog,
          mcpManager,
          logger,
          options.confirmFn,
          options.diffPreviewFn,
          {
            onOutput: (chunk) => callbacks.onToolOutput?.(toolUse.name, chunk, toolUse.id),
            signal,
          },
        );
        logger?.logToolResult(toolUse.name, result.content, result.is_error || false);
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

      // Auto-fix: check for errors after file writes and feed them back
      if (config.autoFixOnFailure && autoFixRetries < config.autoFixMaxRetries) {
        const writtenFiles = pendingToolUses
          .filter((tu) => tu.name === 'write_file' || tu.name === 'edit_file')
          .map((tu) => (tu.input.path || tu.input.file_path) as string)
          .filter(Boolean);

        if (writtenFiles.length > 0) {
          // Small delay to let VS Code language services update diagnostics
          await new Promise((r) => setTimeout(r, 500));

          const diagResults = await Promise.allSettled(writtenFiles.map((f) => getDiagnostics({ path: f })));
          const errors = diagResults
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
            .map((r) => r.value)
            .filter((d) => d.includes('[Error]'));

          if (errors.length > 0) {
            autoFixRetries++;
            callbacks.onText(`\n⚠️ Auto-fixing errors (attempt ${autoFixRetries}/${config.autoFixMaxRetries})...\n`);
            agentMessages.push({
              role: 'user',
              content: [
                {
                  type: 'text' as const,
                  text: `Errors detected after your edits. Please fix them:\n${errors.join('\n')}`,
                },
              ],
            });
          }
        }
      }

      // Continue the loop — model will respond to tool results
      continue;
    }

    // In plan mode, return after first iteration so user can approve
    if (options.planMode && iteration === 1 && fullText) {
      callbacks.onPlanGenerated?.(fullText);
      break;
    }

    // Model finished (end_turn or max_tokens) — done
    break;
  }

  logger?.logDone(iteration);
  callbacks.onDone();
  return agentMessages;
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
    // Last 4 messages: untouched. 4-8: light. 8+: aggressive.
    let maxLen: number;
    if (distFromEnd < 4)
      continue; // keep recent messages intact
    else if (distFromEnd < 8) maxLen = 1000;
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
