import type { ApiBackend } from './backend.js';
import type { ChatMessage, ContentBlock, ToolDefinition, ToolUseContentBlock, StreamEvent } from './types.js';
import { fetchWithRetry } from './retry.js';
import { abortableRead } from './streamUtils.js';

// ---------------------------------------------------------------------------
// LLMManager API types
// ---------------------------------------------------------------------------

interface LLMManagerMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LLMManagerChatRequest {
  model: string;
  messages: LLMManagerMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: LLMManagerTool[];
}

interface LLMManagerTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

interface LLMManagerChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string | null;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface LLMManagerStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Message format conversion
// ---------------------------------------------------------------------------

function toLLMManagerMessages(messages: ChatMessage[], systemPrompt: string): LLMManagerMessage[] {
  const result: LLMManagerMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : extractTextContent(msg.content);
    result.push({
      role: msg.role,
      content,
    });
  }

  return result;
}

function extractTextContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// LLMManager backend
// ---------------------------------------------------------------------------

/**
 * Backend for LLMManager API.
 * Connects to a locally-hosted LLMManager instance via HTTP.
 */
export class LLMManagerBackend implements ApiBackend {
  constructor(
    private baseUrl: string,
    private apiToken: string,
  ) {}

  private get chatUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiToken}`,
    };
  }

  async *streamChat(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const llmMessages = toLLMManagerMessages(messages, systemPrompt);

    const body: LLMManagerChatRequest = {
      model,
      messages: llmMessages,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }));
    }

    const response = await fetchWithRetry(this.chatUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`LLMManager API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No response body from LLMManager');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      let done = false;
      while (!done) {
        const result = await abortableRead(reader, signal);
        done = result.done;
        const chunk = result.value;

        if (chunk) {
          buffer += decoder.decode(chunk, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines[lines.length - 1];

          for (const line of lines.slice(0, -1)) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6);
            if (data === '[DONE]') break;

            try {
              const parsed: LLMManagerStreamChunk = JSON.parse(data);
              const delta = parsed.choices[0]?.delta;

              if (delta?.content) {
                yield { type: 'text', text: delta.content };
              }

              if (delta?.tool_calls) {
                for (const toolCall of delta.tool_calls) {
                  if (toolCall.function?.name) {
                    const toolUse: ToolUseContentBlock = {
                      type: 'tool_use',
                      id: toolCall.id || `tool-${Date.now()}`,
                      name: toolCall.function.name,
                      input: toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {},
                    };
                    yield { type: 'tool_use', toolUse };
                  }
                }
              }
            } catch {
              // Skip lines that aren't valid JSON
              if (data.length > 0) {
                console.warn('[LLMManager] Failed to parse stream line:', data);
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async complete(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const llmMessages = toLLMManagerMessages(messages, systemPrompt);

    const body: LLMManagerChatRequest = {
      model,
      messages: llmMessages,
      max_tokens: maxTokens,
      stream: false,
    };

    const response = await fetchWithRetry(this.chatUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`LLMManager API error ${response.status}: ${errorText}`);
    }

    const data: LLMManagerChatResponse = await response.json();
    return data.choices[0]?.message?.content || '';
  }
}
