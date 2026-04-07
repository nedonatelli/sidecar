import type {
  ChatMessage,
  ContentBlock,
  ToolDefinition,
  ToolUseContentBlock,
  ToolResultContentBlock,
} from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { getToolDefinitions } from './tools.js';
import { executeTool, type ApprovalMode, type ConfirmFn, type DiffPreviewFn } from './executor.js';
import type { AgentLogger } from './logger.js';
import type { ChangeLog } from './changelog.js';
import type { MCPManager } from './mcpManager.js';
import { spawnSubAgent } from './subagent.js';

export interface AgentCallbacks {
  onText: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string, isError: boolean) => void;
  onPlanGenerated?: (plan: string) => void;
  onIterationStart?: (iteration: number, maxIterations: number, elapsedMs: number, estimatedTokens: number) => void;
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
  const startTime = Date.now();

  // Work with a copy of messages
  const agentMessages = [...messages];

  while (iteration < maxIterations) {
    iteration++;
    if (signal.aborted) {
      logger?.logAborted();
      break;
    }
    // Check token budget (estimate: ~4 chars per token)
    const estimatedTokens = Math.ceil(totalChars / 4);
    if (estimatedTokens > maxTokens) {
      logger?.warn(`Token budget exceeded: ~${estimatedTokens} tokens > ${maxTokens} limit`);
      callbacks.onText(`\n\n⚠️ Agent stopped: token budget exceeded (~${estimatedTokens} tokens).`);
      break;
    }

    // Compress context at 70% of budget to extend the loop
    if (estimatedTokens > maxTokens * 0.7) {
      const compressed = compressMessages(agentMessages);
      if (compressed) {
        logger?.info(`Context compressed: removed ${compressed} chars of old tool results`);
        totalChars -= compressed;
      }
    }

    logger?.logIteration(iteration, maxIterations);
    callbacks.onIterationStart?.(iteration, maxIterations, Date.now() - startTime, estimatedTokens);

    // Stream response from model
    const assistantContent: ContentBlock[] = [];
    let fullText = '';
    const pendingToolUses: ToolUseContentBlock[] = [];
    let stopReason = 'end_turn';

    // In plan mode, first iteration runs without tools to generate a plan
    const iterTools = options.planMode && iteration === 1 ? [] : tools;
    const stream = client.streamChat(agentMessages, signal, iterTools);
    for await (const event of stream) {
      if (signal.aborted) break;

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
          callbacks.onToolCall(event.toolUse.name, event.toolUse.input);
          break;
        case 'stop':
          stopReason = event.stopReason;
          break;
      }
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
        callbacks.onToolCall(tu.name, tu.input);
      }
      if (parsed.length > 0) {
        stopReason = 'tool_use';
      }
    }

    // If no tools to execute and no text, the model has nothing to do — stop.
    // Previously this used `continue` which could loop infinitely when
    // stripRepeatedContent emptied the response.
    if (pendingToolUses.length === 0) {
      break;
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
        );
        logger?.logToolResult(toolUse.name, result.content, result.is_error || false);
        callbacks.onToolResult(toolUse.name, result.content, result.is_error || false);
        return result;
      });

      // Execute all tools in parallel
      const results = await Promise.all(executionPromises);
      toolResults.push(...results);

      // Count tool call and result tokens toward the budget
      for (const tu of pendingToolUses) {
        totalChars += tu.name.length + JSON.stringify(tu.input).length;
      }
      for (const tr of toolResults) {
        totalChars += tr.content.length;
      }

      // Add tool results as a user message (Anthropic API format)
      agentMessages.push({
        role: 'user',
        content: toolResults,
      });

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
 * Replaces verbose tool results from earlier iterations with short summaries.
 * Returns the number of characters freed.
 */
export function compressMessages(messages: ChatMessage[]): number {
  let freed = 0;
  // Only compress tool results that aren't in the last 4 messages
  const cutoff = Math.max(0, messages.length - 4);

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;

    const newContent: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.content.length > 200) {
        const original = block.content.length;
        const summary = block.content.slice(0, 100) + '... (truncated)';
        newContent.push({ ...block, content: summary });
        freed += original - summary.length;
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

  // Pattern 1: <function=name><parameter=key>value</parameter>...</function>
  const fnPattern = /<function=(\w+)>([\s\S]*?)<\/function>/g;
  let match;
  while ((match = fnPattern.exec(text)) !== null) {
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
  if (results.length > 0) return results;

  // Pattern 2: <tool_call>{"name":"...","arguments":{...}}</tool_call>
  const tcPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((match = tcPattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
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
  if (results.length > 0) return results;

  // Pattern 3: JSON block with name + arguments in a code fence
  const jsonPattern = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/g;
  while ((match = jsonPattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
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
  // Collect text from previous assistant messages
  const previousTexts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') {
      previousTexts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          previousTexts.push(block.text);
        }
      }
    }
  }

  if (previousTexts.length === 0) return text;

  // Extract code block positions so we don't strip content inside them
  const codeBlockRanges: { start: number; end: number }[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let cbMatch;
  while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
    codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
  }

  const isInsideCodeBlock = (idx: number) => codeBlockRanges.some((r) => idx >= r.start && idx < r.end);

  let result = text;
  for (const prev of previousTexts) {
    // Find substantial blocks (200+ chars) from previous messages that appear in the new text
    const paragraphs = prev.split(/\n\n+/).filter((p) => p.trim().length >= 200);
    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      const idx = result.indexOf(trimmed);
      if (idx !== -1 && !isInsideCodeBlock(idx)) {
        result = result.slice(0, idx) + result.slice(idx + trimmed.length);
        result = result.trim();
      }
    }
  }

  // Clean up leftover whitespace from removals
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}
