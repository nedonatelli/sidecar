import type { ApiBackend } from './backend.js';
import type { ChatMessage, ContentBlock, ToolDefinition, ToolUseContentBlock, StreamEvent } from './types.js';
import { fetchWithRetry } from './retry.js';
import {
  abortableRead,
  toFunctionTools,
  parseThinkTags,
  parseTextToolCallsStream,
  flushTextToolCallsStream,
  createTextToolCallState,
  type ThinkTagState,
  type TextToolCallState,
} from './streamUtils.js';
import { getConfig } from '../config/settings.js';
import { RateLimitStore, maybeWaitForRateLimit } from './rateLimitState.js';
import { parseOpenAIRateLimitHeaders } from './rateLimitHeaders.js';
import { prunePrompt } from './promptPruner.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';

/** How long we'll wait on a rate-limit reset before bailing to the caller. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * Cap on completion tokens per request. OpenAI's rate limiter reserves
 * `max_tokens` against the TPM bucket at request time, even though
 * billing only counts tokens actually produced. When `max_tokens` is
 * omitted, OpenAI defaults to the model's max output (e.g. ~16k for
 * gpt-4o), which drains a 200k TPM bucket in ~10 requests even though
 * real spend stays tiny. 4096 matches our local estimator and is
 * plenty for the small completions an agent produces between tool
 * calls (the loop continues with a follow-up request if a completion
 * hits the cap, so truncation is graceful).
 */
const MAX_OUTPUT_TOKENS = 4096;

function estimateRequestTokens(systemPrompt: string, messages: ChatMessage[], maxOutputTokens: number): number {
  let chars = systemPrompt.length;
  for (const m of messages) {
    const c = m.content;
    chars += typeof c === 'string' ? c.length : c.reduce((sum, b) => sum + JSON.stringify(b).length, 0);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + maxOutputTokens;
}

/**
 * Size a raw string value in approximate tokens. Shared between the
 * estimator above and the verbose-mode breakdown logger so both agree
 * on the char→token ratio.
 */
function approxTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/**
 * Log a one-line breakdown of what's inside the outgoing request body
 * — system prompt size, message history size, tool definitions size —
 * when verbose mode is on. Helps diagnose why a chat is burning TPM
 * faster than expected: in practice one of the three buckets is
 * usually dominant and compacting it lands the biggest win.
 */
function logRequestSizeBreakdown(
  model: string,
  systemPrompt: string,
  messages: OpenAIMessage[],
  tools: unknown[] | undefined,
): void {
  if (!getConfig().verboseMode) return;
  const systemTokens = approxTokens(systemPrompt);
  const historyChars = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const historyTokens = Math.ceil(historyChars / CHARS_PER_TOKEN);
  const toolsTokens = tools ? approxTokens(JSON.stringify(tools)) : 0;
  const total = systemTokens + historyTokens + toolsTokens;
  console.log(
    `[SideCar openai ${model}] request breakdown ≈ ` +
      `system=${systemTokens.toLocaleString()}t · ` +
      `history=${historyTokens.toLocaleString()}t · ` +
      `tools=${toolsTokens.toLocaleString()}t · ` +
      `total=${total.toLocaleString()}t`,
  );
}

// Monotonic counter for generating unique tool call IDs when the API doesn't provide one
let toolCallIdCounter = 0;

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
  // Present only on the final chunk when the request body included
  // `stream_options: { include_usage: true }`. OpenAI ships this
  // separately from the choice chunks (choices is []).
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
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
    private rateLimits: RateLimitStore = new RateLimitStore(),
  ) {}

  /** Expose the rate-limit snapshot for status UIs and tests. */
  getRateLimits(): RateLimitStore {
    return this.rateLimits;
  }

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
    const cfg = getConfig();
    const pruned = prunePrompt(systemPrompt, messages, {
      enabled: cfg.promptPruningEnabled,
      maxToolResultTokens: cfg.promptPruningMaxToolResultTokens,
    });
    const openaiMessages = toOpenAIMessages(pruned.messages, pruned.systemPrompt);
    const functionTools = tools && tools.length > 0 ? toFunctionTools(tools) : undefined;

    const body: Record<string, unknown> = {
      model,
      messages: openaiMessages,
      stream: true,
      // Cap reservation against the TPM bucket — see MAX_OUTPUT_TOKENS
      // rationale above. Omitting this made OpenAI reserve the model's
      // full default output cap per request and drain the bucket in
      // ~10 requests at low actual spend.
      max_tokens: MAX_OUTPUT_TOKENS,
      // Ask OpenAI to include `usage` on the final stream chunk so we
      // can emit a StreamUsageEvent and feed spendTracker with real
      // numbers instead of heuristic estimates.
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { temperature: cfg.agentTemperature } : {}),
    };

    if (functionTools) {
      body.tools = functionTools;
    }

    logRequestSizeBreakdown(model, pruned.systemPrompt, openaiMessages, functionTools);

    await maybeWaitForRateLimit(
      this.rateLimits,
      estimateRequestTokens(pruned.systemPrompt, pruned.messages, MAX_OUTPUT_TOKENS),
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
    const textToolState: TextToolCallState = createTextToolCallState(tools);

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
                  id: tc.id || `openai_tc_${++toolCallIdCounter}`,
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

          // Usage-only chunk (OpenAI emits this as the last chunk when
          // stream_options.include_usage=true is set). choices[] is
          // empty — don't treat the absence of a choice as a parse skip.
          if (chunk.usage) {
            const u = chunk.usage;
            yield {
              type: 'usage',
              model,
              usage: {
                inputTokens: u.prompt_tokens ?? 0,
                outputTokens: u.completion_tokens ?? 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
              },
            };
            // Also log actual usage side-by-side with the earlier
            // request-size estimate so we can tell how close the
            // estimator is to the real OpenAI count.
            if (getConfig().verboseMode) {
              console.log(
                `[SideCar openai ${model}] actual usage: ` +
                  `prompt=${(u.prompt_tokens ?? 0).toLocaleString()}t · ` +
                  `completion=${(u.completion_tokens ?? 0).toLocaleString()}t · ` +
                  `total=${(u.total_tokens ?? 0).toLocaleString()}t`,
              );
            }
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Handle text content: <think> tag parsing plus XML-style text
          // tool-call interception for models that don't use structured tool_calls.
          if (delta.content) {
            for (const ev of parseThinkTags(delta.content, thinkState)) {
              if (ev.type === 'text') {
                yield* parseTextToolCallsStream(ev.text, textToolState);
              } else {
                yield ev;
              }
            }
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
                  id: tc.id || `openai_tc_${++toolCallIdCounter}`,
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
      // Drain any text still buffered by the streaming tool-call parser.
      yield* flushTextToolCallsStream(textToolState);
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
