import type { ApiBackend } from './backend.js';
import type { ChatMessage, ContentBlock, ToolDefinition, StreamEvent } from './types.js';
import { fetchWithRetry } from './retry.js';
import { streamOpenAiSse } from './openAiSseStream.js';
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

// KickstandStreamChunk removed — the SSE parser lives in openAiSseStream.ts
// now and owns its own OpenAIChatChunk type. Kickstand streams the same
// dialect, so there's nothing left for this file to describe.

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

    // Delegate SSE parsing to the shared OpenAI-compatible helper.
    // Kickstand's stream protocol is identical to OpenAI's
    // /v1/chat/completions, so the helper picks up think-tag parsing,
    // text tool-call interception, incremental tool_call accumulation,
    // and usage event emission for free — all capabilities the old
    // hand-rolled parser was missing.
    yield* streamOpenAiSse(response, model, tools, signal, {
      providerLabel: 'kickstand',
      toolCallIdPrefix: 'kickstand',
    });
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
