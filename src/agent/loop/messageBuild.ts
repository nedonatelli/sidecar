import type { ContentBlock, ToolResultContentBlock, ToolUseContentBlock } from '../../ollama/types.js';
import { getContentLength } from '../../ollama/types.js';
import { truncateForTool } from '../../ollama/promptPruner.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Message-history builders for runAgentLoop.
//
// Three tiny helpers that package the common "push a message and
// update accounting" ceremony the loop does in three places:
//
//   1. After the stream lands, build the assistant message from the
//      collected text + tool_use blocks and append it to history.
//
//   2. After tools execute, append a user-role message wrapping the
//      tool_result blocks (Anthropic API format: the tool results
//      live inside a synthetic user message).
//
//   3. Account the assistant's tool-use blocks and the user's tool-
//      result blocks against the total-chars budget.
//
// These used to be inline in runAgentLoop, scattered across ~40
// lines. Extracted so the orchestrator reads as pseudo-code:
// "stream turn → push assistant → execute → push tool results →
// account → compress".
// ---------------------------------------------------------------------------

/**
 * Append the assistant turn to message history. Combines a leading
 * text block (if present) with every emitted `tool_use` block.
 * No-op when both are absent — the caller has to handle the
 * empty-turn case separately, because that path also needs to run
 * the completion gate.
 */
export function pushAssistantMessage(state: LoopState, fullText: string, pendingToolUses: ToolUseContentBlock[]): void {
  const assistantContent: ContentBlock[] = [];
  if (fullText) {
    assistantContent.push({ type: 'text', text: fullText });
  }
  for (const tu of pendingToolUses) {
    assistantContent.push(tu);
  }
  if (assistantContent.length > 0) {
    state.messages.push({
      role: 'assistant',
      content: assistantContent,
    });
  }
}

/**
 * Append tool results as a synthetic user message (Anthropic API
 * format requires tool_result blocks to live on a user turn).
 */
export function pushToolResultsMessage(state: LoopState, toolResults: ToolResultContentBlock[]): void {
  state.messages.push({
    role: 'user',
    content: toolResults,
  });
}

/**
 * Truncate each tool result to `maxTokens` using the per-tool strategy
 * from promptPruner. Returns a new array (original objects reused when
 * content is unchanged to avoid allocation).
 *
 * Call this BEFORE accountToolTokens so totalChars tracks the truncated
 * size — the same size the model will actually see. Without this,
 * a broad grep that returns 500 KB gets counted at full size even though
 * the backend would have capped it at 8 KB, causing premature budget
 * exhaustion in a fresh conversation.
 */
export function capToolResults(
  toolResults: ToolResultContentBlock[],
  pendingToolUses: ToolUseContentBlock[],
  maxTokens: number,
): ToolResultContentBlock[] {
  const nameById = new Map(pendingToolUses.map((tu) => [tu.id, tu.name]));
  return toolResults.map((r) => {
    const { text } = truncateForTool(nameById.get(r.tool_use_id), r.content, maxTokens);
    return text === r.content ? r : { ...r, content: text };
  });
}

/**
 * Account assistant tool-use blocks and tool-result content against
 * the total-chars budget. Delegates to `getContentLength` so
 * tool_use / tool_result accounting stays in one place — same
 * function runs on the initial-history seed in `initLoopState`, the
 * compression threshold checks, and here, so the numbers are
 * consistent across every budget decision.
 */
export function accountToolTokens(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
): void {
  state.totalChars += getContentLength(pendingToolUses);
  state.totalChars += getContentLength(toolResults);
}
