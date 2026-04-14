import type { ApiBackend } from './backend.js';
import type { ChatMessage, ContentBlock, ToolDefinition, ToolUseContentBlock, StreamEvent } from './types.js';
import { fetchWithRetry } from './retry.js';
import { abortableRead } from './streamUtils.js';
import { RateLimitStore, maybeWaitForRateLimit } from './rateLimitState.js';
import { parseOpenAIRateLimitHeaders } from './rateLimitHeaders.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';

const MAX_RATE_LIMIT_WAIT_MS = 60_000;

function estimateRequestTokens(systemPrompt: string, messages: ChatMessage[], maxOutputTokens: number): number {
  let chars = systemPrompt.length;
  for (const m of messages) {
    const c = m.content;
    chars += typeof c === 'string' ? c.length : c.reduce((sum, b) => sum + JSON.stringify(b).length, 0);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + maxOutputTokens;
}

// ---------------------------------------------------------------------------
// Kickstand API types
// ---------------------------------------------------------------------------

interface KickstandMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface KickstandChatRequest {
  model: string;
  messages: KickstandMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: KickstandTool[];
}

interface KickstandTool {
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

interface KickstandChatResponse {
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

interface KickstandStreamChunk {
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

function toKickstandMessages(messages: ChatMessage[], systemPrompt: string): KickstandMessage[] {
  const result: KickstandMessage[] = [];

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
// Kickstand backend
// ---------------------------------------------------------------------------

/**
 * Backend for Kickstand API.
 * Connects to a locally-hosted Kickstand instance via HTTP.
 */
export class KickstandBackend implements ApiBackend {
  constructor(
    private baseUrl: string,
    private apiToken: string,
    private rateLimits: RateLimitStore = new RateLimitStore(),
  ) {}

  getRateLimits(): RateLimitStore {
    return this.rateLimits;
  }

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
    const llmMessages = toKickstandMessages(messages, systemPrompt);

    const body: KickstandChatRequest = {
      model,
      messages: llmMessages,
      stream: true,
      // Same rationale as OpenAIBackend — omitting max_tokens lets a
      // rate-limited OpenAI-compatible server reserve its model
      // default against the TPM bucket, which drains the budget long
      // before actual consumption matches. Cap at a safe agent-loop
      // completion size; if a turn legitimately needs more, the loop
      // continues with a follow-up request.
      max_tokens: 4096,
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

    await maybeWaitForRateLimit(
      this.rateLimits,
      estimateRequestTokens(systemPrompt, messages, 4096),
      MAX_RATE_LIMIT_WAIT_MS,
      signal,
    );

    const response = await fetchWithRetry(this.chatUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    this.rateLimits.update(parseOpenAIRateLimitHeaders(response.headers));

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Kickstand API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No response body from Kickstand');
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
              const parsed: KickstandStreamChunk = JSON.parse(data);
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
                console.warn('[Kickstand] Failed to parse stream line:', data);
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
    const llmMessages = toKickstandMessages(messages, systemPrompt);

    const body: KickstandChatRequest = {
      model,
      messages: llmMessages,
      max_tokens: maxTokens,
      stream: false,
    };

    await maybeWaitForRateLimit(
      this.rateLimits,
      estimateRequestTokens(systemPrompt, messages, maxTokens),
      MAX_RATE_LIMIT_WAIT_MS,
      signal,
    );

    const response = await fetchWithRetry(this.chatUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    this.rateLimits.update(parseOpenAIRateLimitHeaders(response.headers));

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Kickstand API error ${response.status}: ${errorText}`);
    }

    const data: KickstandChatResponse = await response.json();
    return data.choices[0]?.message?.content || '';
  }
}
