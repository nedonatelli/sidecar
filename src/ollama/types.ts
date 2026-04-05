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

export type ContentBlock = TextContentBlock | ImageContentBlock | ToolUseContentBlock | ToolResultContentBlock | ThinkingContentBlock;

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
export function getContentText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextContentBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

export function getContentLength(content: string | ContentBlock[]): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, block) => {
    if (block.type === 'text') return sum + block.text.length;
    if (block.type === 'tool_result') return sum + block.content.length;
    if (block.type === 'tool_use') return sum + JSON.stringify(block.input).length;
    return sum + 100;
  }, 0);
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

export type StreamEvent = StreamTextEvent | StreamToolUseEvent | StreamThinkingEvent | StreamStopEvent;

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
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error';
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
