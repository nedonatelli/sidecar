import type { ChatMessage, ToolDefinition, StreamEvent } from './types.js';

/**
 * Abstraction over different LLM API backends.
 * Implementations handle protocol differences (Anthropic Messages API vs Ollama native).
 */
export interface ApiBackend {
  streamChat(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent>;

  complete(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string>;
}
