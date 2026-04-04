export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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
