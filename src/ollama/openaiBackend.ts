import type { ApiBackend } from './backend.js';
import type { ChatMessage, ContentBlock, ToolDefinition, ToolUseContentBlock, StreamEvent } from './types.js';
import { fetchWithRetry } from './retry.js';
import { abortableRead, toFunctionTools, parseThinkTags, type ThinkTagState } from './streamUtils.js';
import { getConfig } from '../config/settings.js';

// ---------------------------------------------------------------------------
// OpenAI-compatible API types
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChatChunk {
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Message format conversion
// ---------------------------------------------------------------------------

export function toOpenAIMessages(messages: ChatMessage[], systemPrompt: string): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content as ContentBlock[];

    if (msg.role === 'user') {
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      const textBlocks = blocks.filter((b) => b.type === 'text');

      // Emit tool result messages
      for (const tr of toolResults) {
        if (tr.type === 'tool_result') {
          result.push({ role: 'tool', content: tr.content, tool_call_id: tr.tool_use_id });
        }
      }

      // Emit text as user message
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        result.push({ role: 'user', content: text });
      }
    } else {
      // Assistant messages may contain text + tool_use blocks
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('\n') || null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible backend
// ---------------------------------------------------------------------------

/**
 * Backend for any OpenAI-compatible API server.
 * Works with LM Studio, vLLM, llama.cpp, text-generation-webui,
 * OpenRouter, and any server exposing /v1/chat/completions.
 */
export class OpenAIBackend implements ApiBackend {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private get chatUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  private get modelsUrl(): string {
    return `${this.baseUrl}/v1/models`;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey && this.apiKey !== 'ollama') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async *streamChat(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const { agentTemperature } = getConfig();
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAIMessages(messages, systemPrompt),
      stream: true,
      ...(tools && tools.length > 0 ? { temperature: agentTemperature } : {}),
    };

    if (tools && tools.length > 0) {
      body.tools = toFunctionTools(tools);
    }

    const response = await fetchWithRetry(this.chatUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `OpenAI API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    if (!response.body) {
      throw new Error('OpenAI API returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const thinkState: ThinkTagState = { insideThinkTag: false };

    // Accumulate incremental tool call data keyed by index
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      let buffer = '';
      while (true) {
        const { done, value } = await abortableRead(reader, signal);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            // Flush any remaining tool calls
            for (const [, tc] of pendingToolCalls) {
              if (tc.name) {
                let parsedArgs: Record<string, unknown> = {};
                try {
                  parsedArgs = JSON.parse(tc.arguments || '{}');
                } catch {
                  /* malformed args */
                }
                const toolUse: ToolUseContentBlock = {
                  type: 'tool_use',
                  id: tc.id || `openai_tc_${Date.now()}`,
                  name: tc.name,
                  input: parsedArgs,
                };
                yield { type: 'tool_use', toolUse };
              }
            }
            pendingToolCalls.clear();
            continue;
          }

          let chunk: OpenAIChatChunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Handle text content with <think> tag parsing
          if (delta.content) {
            yield* parseThinkTags(delta.content, thinkState);
          }

          // Handle incremental tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = pendingToolCalls.get(tc.index) || { id: '', name: '', arguments: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              pendingToolCalls.set(tc.index, existing);
            }
          }

          // Handle finish reasons
          if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
            // Flush accumulated tool calls
            for (const [, tc] of pendingToolCalls) {
              if (tc.name) {
                let parsedArgs: Record<string, unknown> = {};
                try {
                  parsedArgs = JSON.parse(tc.arguments || '{}');
                } catch {
                  /* malformed args */
                }
                const toolUse: ToolUseContentBlock = {
                  type: 'tool_use',
                  id: tc.id || `openai_tc_${Date.now()}`,
                  name: tc.name,
                  input: parsedArgs,
                };
                yield { type: 'tool_use', toolUse };
              }
            }
            pendingToolCalls.clear();
            yield { type: 'stop', stopReason: 'tool_use' };
          } else if (choice.finish_reason === 'stop') {
            yield { type: 'stop', stopReason: 'end_turn' };
          } else if (choice.finish_reason === 'length') {
            yield { type: 'stop', stopReason: 'max_tokens' };
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
    const body = {
      model,
      messages: toOpenAIMessages(messages, systemPrompt),
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
      throw new Error(
        `OpenAI API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content || '';
  }

  /** List available models from the /v1/models endpoint. */
  async listModels(): Promise<{ id: string; owned_by?: string }[]> {
    try {
      const response = await fetch(this.modelsUrl, { headers: this.getHeaders() });
      if (!response.ok) return [];
      const data = (await response.json()) as { data: { id: string; owned_by?: string }[] };
      return data.data || [];
    } catch {
      return [];
    }
  }
}
