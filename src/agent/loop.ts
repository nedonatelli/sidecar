import type { ChatMessage, ContentBlock, ToolUseContentBlock, ToolResultContentBlock, StreamEvent } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { getToolDefinitions } from './tools.js';
import { executeTool, type ApprovalMode } from './executor.js';
import type { AgentLogger } from './logger.js';

export interface AgentCallbacks {
  onText: (text: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string, isError: boolean) => void;
  onDone: () => void;
}

export interface AgentOptions {
  maxIterations?: number;
  approvalMode?: ApprovalMode;
  logger?: AgentLogger;
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
  const tools = getToolDefinitions();
  let iteration = 0;

  // Work with a copy of messages
  const agentMessages = [...messages];

  while (iteration < maxIterations) {
    iteration++;
    if (signal.aborted) {
      logger?.logAborted();
      break;
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
          callbacks.onText(event.text);
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
        const result = await executeTool(toolUse, approvalMode);
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
