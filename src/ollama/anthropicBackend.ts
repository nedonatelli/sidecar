import type { ApiBackend } from './backend.js';
import type {
  ChatMessage,
  ToolDefinition,
  ToolUseContentBlock,
  AnthropicResponse,
  AnthropicStreamEvent,
  StreamEvent,
} from './types.js';
import { fetchWithRetry } from './retry.js';
import { getConfig } from '../config/settings.js';
import { abortableRead } from './streamUtils.js';
import { RateLimitStore, maybeWaitForRateLimit } from './rateLimitState.js';
import { parseAnthropicRateLimitHeaders } from './rateLimitHeaders.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';

/** How long we'll wait on a rate-limit reset before telling the user to switch backends. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** Rough token estimate for a system+messages payload using the shared chars/token ratio. */
function estimateRequestTokens(systemPrompt: string, messages: ChatMessage[], maxOutputTokens: number): number {
  let chars = systemPrompt.length;
  for (const m of messages) {
    const c = m.content;
    chars += typeof c === 'string' ? c.length : c.reduce((sum, b) => sum + JSON.stringify(b).length, 0);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + maxOutputTokens;
}

/**
 * Split the system prompt into cached (stable) and dynamic blocks.
 * The stable prefix (base prompt + SIDECAR.md + user config) is marked
 * with cache_control so Anthropic caches it server-side (~90% cheaper).
 * The dynamic workspace context is sent uncached since it changes per query.
 */
const WORKSPACE_CONTEXT_MARKER = '## Workspace Structure';

export function buildSystemBlocks(
  systemPrompt: string,
): { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] {
  const markerIndex = systemPrompt.indexOf(WORKSPACE_CONTEXT_MARKER);
  if (markerIndex <= 0) {
    // No workspace context — cache the entire system prompt
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  }
  // Split into stable prefix (cached) and dynamic workspace context (not cached)
  const stablePrefix = systemPrompt.slice(0, markerIndex).trimEnd();
  const dynamicContext = systemPrompt.slice(markerIndex);
  return [
    { type: 'text', text: stablePrefix, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicContext },
  ];
}

/**
 * Backend for the Anthropic Messages API (/v1/messages).
 * Used when connecting to https://api.anthropic.com or any Anthropic-compatible proxy.
 */
export class AnthropicBackend implements ApiBackend {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private rateLimits: RateLimitStore = new RateLimitStore(),
  ) {}

  /** Expose the rate-limit snapshot for status UIs and tests. */
  getRateLimits(): RateLimitStore {
    return this.rateLimits;
  }

  private get messagesUrl(): string {
    return `${this.baseUrl}/v1/messages`;
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
      max_tokens: 8192,
      messages,
      stream: true,
      ...(tools && tools.length > 0 ? { temperature: agentTemperature } : {}),
    };

    if (systemPrompt) {
      body.system = buildSystemBlocks(systemPrompt);
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    // Pre-check against the last known rate-limit budget. Waits the
    // computed time (if any), or throws RateLimitWaitTooLongError if
    // the wait would exceed MAX_RATE_LIMIT_WAIT_MS — better than burning
    // a retry on a request the server is guaranteed to reject.
    await maybeWaitForRateLimit(
      this.rateLimits,
      estimateRequestTokens(systemPrompt, messages, 8192),
      MAX_RATE_LIMIT_WAIT_MS,
      signal,
    );

    const response = await fetchWithRetry(this.messagesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    // Update rate-limit state from headers before inspecting `response.ok`
    // so a 429 response still refreshes the store and future waits land
    // on the freshest numbers.
    this.rateLimits.update(parseAnthropicRateLimitHeaders(response.headers));

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Anthropic API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    if (!response.body) {
      throw new Error('Anthropic API returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
    let currentThinking = false;

    try {
      let buffer = '';
      while (true) {
        const { done, value } = await abortableRead(reader, signal);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          let event: AnthropicStreamEvent;
          try {
            event = JSON.parse(data) as AnthropicStreamEvent;
          } catch {
            continue;
          }

          switch (event.type) {
            case 'content_block_start':
              if (event.content_block?.type === 'tool_use') {
                currentToolUse = {
                  id: event.content_block.id || '',
                  name: event.content_block.name || '',
                  inputJson: '',
                };
              } else if (event.content_block?.type === 'thinking') {
                currentThinking = true;
              }
              break;

            case 'content_block_delta':
              if (!event.delta) break;
              if (event.delta.type === 'text_delta' && event.delta.text) {
                yield { type: 'text', text: event.delta.text };
              } else if (event.delta.type === 'thinking_delta' && event.delta.thinking && currentThinking) {
                yield { type: 'thinking', thinking: event.delta.thinking };
              } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json && currentToolUse) {
                currentToolUse.inputJson += event.delta.partial_json;
              }
              break;

            case 'content_block_stop':
              currentThinking = false;
              if (currentToolUse) {
                let input: Record<string, unknown> = {};
                let malformedRaw: string | undefined;
                try {
                  input = JSON.parse(currentToolUse.inputJson || '{}');
                } catch {
                  // Malformed JSON — surface the raw text to the executor
                  // so it can return a descriptive error instead of
                  // silently calling the tool with `{}`.
                  malformedRaw = currentToolUse.inputJson;
                }
                const toolUse: ToolUseContentBlock = {
                  type: 'tool_use',
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input,
                  ...(malformedRaw !== undefined ? { _malformedInputRaw: malformedRaw } : {}),
                };
                yield { type: 'tool_use', toolUse };
                currentToolUse = null;
              }
              break;

            case 'message_delta':
              if (event.delta?.stop_reason) {
                yield { type: 'stop', stopReason: event.delta.stop_reason };
              }
              break;

            case 'error':
              if (event.error) {
                throw new Error(event.error.message);
              }
              break;
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
    maxTokens: number = 256,
    signal?: AbortSignal,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages,
      stream: false,
    };

    if (systemPrompt) {
      body.system = buildSystemBlocks(systemPrompt);
    }

    await maybeWaitForRateLimit(
      this.rateLimits,
      estimateRequestTokens(systemPrompt, messages, maxTokens),
      MAX_RATE_LIMIT_WAIT_MS,
      signal,
    );

    const response = await fetchWithRetry(this.messagesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    this.rateLimits.update(parseAnthropicRateLimitHeaders(response.headers));

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Anthropic API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  }
}
