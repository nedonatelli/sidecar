// Content block types

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Populated when the backend received structured tool input that failed
   * to parse as JSON (truncated stream, malformed delta, etc). The
   * executor surfaces this as an explicit error tool_result so the agent
   * sees "your tool input was malformed, here's the raw text, please
   * retry" instead of silently calling the tool with `{}`.
   */
  _malformedInputRaw?: string;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ThinkingContentBlock {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ThinkingContentBlock;

// Tool definition (sent to API)
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Messages
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// Utility functions
/**
 * Maximum size for tool result content when persisting messages.
 * Keeps storage manageable while preserving enough context to be useful.
 */
const MAX_PERSISTED_TOOL_RESULT = 2000;

/**
 * Serialize message content for persistence, preserving structure.
 * Unlike getContentText(), this keeps tool_use, tool_result, and thinking
 * blocks so conversations can be fully restored when switching sessions.
 *
 * - Images are stripped (base64 data is too large for storage)
 * - Tool results are truncated to MAX_PERSISTED_TOOL_RESULT chars
 * - Everything else is kept as-is
 */
export function serializeContent(content: string | ContentBlock[]): string | ContentBlock[] {
  if (typeof content === 'string') return content;

  const serialized: ContentBlock[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'image':
        // Drop base64 image data — too large for persistent storage
        break;
      case 'tool_result':
        // Truncate large tool results but preserve the block
        serialized.push({
          ...block,
          content:
            block.content.length > MAX_PERSISTED_TOOL_RESULT
              ? block.content.slice(0, MAX_PERSISTED_TOOL_RESULT) + '\n... (truncated)'
              : block.content,
        });
        break;
      default:
        serialized.push(block);
        break;
    }
  }

  // If only text blocks remain, flatten to string for compact storage
  if (serialized.length === 1 && serialized[0].type === 'text') {
    return serialized[0].text;
  }
  return serialized;
}

export function getContentText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextContentBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function getContentLength(content: string | ContentBlock[]): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, block) => {
    if (block.type === 'text') return sum + block.text.length;
    if (block.type === 'tool_result') return sum + block.content.length;
    if (block.type === 'tool_use') return sum + block.name.length + estimateInputSize(block.input);
    return sum + 100;
  }, 0);
}

/** Estimate the character size of a tool input object without JSON.stringify. */
function estimateInputSize(input: Record<string, unknown>): number {
  let size = 0;
  for (const v of Object.values(input)) {
    if (typeof v === 'string') size += v.length;
    else if (typeof v === 'number' || typeof v === 'boolean') size += 8;
    else if (v !== null && v !== undefined) size += String(v).length;
  }
  return size;
}

// Stream events emitted by the client
export interface StreamTextEvent {
  type: 'text';
  text: string;
}

export interface StreamToolUseEvent {
  type: 'tool_use';
  toolUse: ToolUseContentBlock;
}

export interface StreamThinkingEvent {
  type: 'thinking';
  thinking: string;
}

export interface StreamStopEvent {
  type: 'stop';
  stopReason: string;
}

export interface StreamWarningEvent {
  type: 'warning';
  message: string;
}

export type StreamEvent =
  | StreamTextEvent
  | StreamToolUseEvent
  | StreamThinkingEvent
  | StreamStopEvent
  | StreamWarningEvent;

// Anthropic Messages API types

export interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  usage: { input_tokens: number; output_tokens: number };
}

// Streaming event types
export interface AnthropicStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping'
    | 'error';
  message?: AnthropicResponse;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'message_delta';
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  error?: { type: string; message: string };
}
