import type { ChatMessage, ContentBlock, ToolUseContentBlock, ToolResultContentBlock, StreamEvent } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { getToolDefinitions } from './tools.js';
import { executeTool, type ApprovalMode } from './executor.js';
import type { AgentLogger } from './logger.js';
import type { ChangeLog } from './changelog.js';

export interface AgentCallbacks {
  onText: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string, isError: boolean) => void;
  onDone: () => void;
}

export interface AgentOptions {
  maxIterations?: number;
  maxTokens?: number;
  approvalMode?: ApprovalMode;
  logger?: AgentLogger;
  changelog?: ChangeLog;
}

const DEFAULT_MAX_ITERATIONS = 25;

export async function runAgentLoop(
  client: SideCarClient,
  messages: ChatMessage[],
  callbacks: AgentCallbacks,
  signal: AbortSignal,
  options: AgentOptions = {}
): Promise<ChatMessage[]> {
  const maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
  const approvalMode = options.approvalMode || 'cautious';
  const logger = options.logger;
  const changelog = options.changelog;
  const maxTokens = options.maxTokens || 100_000;
  const tools = getToolDefinitions();
  let iteration = 0;
  let totalChars = 0;

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

    // Stream response from model
    const assistantContent: ContentBlock[] = [];
    let fullText = '';
    const pendingToolUses: ToolUseContentBlock[] = [];
    let stopReason = 'end_turn';

    const stream = client.streamChat(agentMessages, signal, tools);
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
    if (stopReason === 'tool_use' && pendingToolUses.length > 0) {
      const toolResults: ToolResultContentBlock[] = [];
      for (const toolUse of pendingToolUses) {
        const result = await executeTool(toolUse, approvalMode, changelog);
        toolResults.push(result);
        logger?.logToolResult(toolUse.name, result.content, result.is_error || false);
        callbacks.onToolResult(
          toolUse.name,
          result.content,
          result.is_error || false
        );
      }

      // Add tool results as a user message (Anthropic API format)
      agentMessages.push({
        role: 'user',
        content: toolResults,
      });

      // Continue the loop — model will respond to tool results
      continue;
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
function compressMessages(messages: ChatMessage[]): number {
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
