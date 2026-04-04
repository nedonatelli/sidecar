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

export type ContentBlock = TextContentBlock | ImageContentBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// Utility to extract text from message content
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
    return sum + 100; // rough estimate for image token cost
  }, 0);
}

// Anthropic Messages API types

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: ChatMessage[];
  system?: string;
  stream?: boolean;
}

export interface AnthropicContentBlock {
  type: 'text';
  text: string;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  usage: { input_tokens: number; output_tokens: number };
}

// Streaming event types
export interface AnthropicStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error';
  message?: AnthropicResponse;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: { type: 'text_delta'; text: string } | { type: 'message_delta'; stop_reason: string };
  error?: { type: string; message: string };
}
