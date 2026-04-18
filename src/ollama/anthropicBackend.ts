import type { ApiBackend } from './backend.js';
import type {
  ChatMessage,
  ContentBlock,
  ToolDefinition,
  ToolUseContentBlock,
  AnthropicResponse,
  AnthropicStreamEvent,
  StreamEvent,
} from './types.js';
import { getConfig } from '../config/settings.js';
import { abortableRead } from './streamUtils.js';
import { RateLimitStore } from './rateLimitState.js';
import { parseAnthropicRateLimitHeaders } from './rateLimitHeaders.js';
import { sidecarFetch } from './sidecarFetch.js';
import { spendTracker } from './spendTracker.js';
import { prunePrompt, formatPruneStats } from './promptPruner.js';
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
 * Mark the last tool definition with `cache_control` so Anthropic caches
 * the entire tool block server-side. Tool schemas are identical across
 * every turn of an agent loop, so this turns a ~1-4k token repeat cost
 * into a one-time write + per-turn 10% cache read.
 */
export function prepareToolsForCache(tools: ToolDefinition[]): ToolDefinition[] {
  if (tools.length === 0) return tools;
  return tools.map((tool, i) =>
    i === tools.length - 1 ? ({ ...tool, cache_control: { type: 'ephemeral' } } as ToolDefinition) : tool,
  );
}

/**
 * Mark the last content block of the second-to-last user message with
 * `cache_control`, so prior conversation history is cached across agent
 * iterations. The breakpoint is placed one turn behind the latest input
 * so the current turn is still cheap to write — on the next iteration
 * it'll extend the cached prefix.
 *
 * Returns a new array; original messages are not mutated. Content is
 * normalized from string → text-block form on the marked message so
 * cache_control can attach to a block.
 */
export function prepareMessagesForCache(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length < 3) return messages;

  // Find the second-to-last user message index.
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIndices.push(i);
  }
  if (userIndices.length < 2) return messages;
  const targetIdx = userIndices[userIndices.length - 2];

  const result = messages.slice();
  const target = result[targetIdx];
  const content = target.content;

  const cached = { cache_control: { type: 'ephemeral' } };
  if (typeof content === 'string') {
    result[targetIdx] = {
      ...target,
      content: [{ type: 'text', text: content, ...cached } as unknown as ContentBlock],
    };
  } else if (Array.isArray(content) && content.length > 0) {
    const newBlocks = content.slice();
    const last = newBlocks[newBlocks.length - 1];
    newBlocks[newBlocks.length - 1] = { ...last, ...cached } as unknown as ContentBlock;
    result[targetIdx] = { ...target, content: newBlocks };
  }
  return result;
}

/**
 * Backend for the Anthropic Messages API (/v1/messages).
 * Used when connecting to https://api.anthropic.com or any Anthropic-compatible proxy.
 */
export class AnthropicBackend implements ApiBackend {
  private apiKey: string;
  constructor(
    private baseUrl: string,
    apiKey: string,
    private rateLimits: RateLimitStore = new RateLimitStore(),
  ) {
    this.apiKey = apiKey.trim();
  }

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
    const cfg = getConfig();
    const pruned = prunePrompt(systemPrompt, messages, {
      enabled: cfg.promptPruningEnabled,
      maxToolResultTokens: cfg.promptPruningMaxToolResultTokens,
    });
    // v0.62.1 p.2a — observability. Previously PruneStats was
    // computed and discarded; post-mortem diagnosis of "did the
    // pruner eat my error message?" was impossible. Log via
    // console.info so the SideCar output channel captures it.
    const _pruneLog = formatPruneStats(pruned.stats);
    if (_pruneLog) console.info(`[SideCar] ${_pruneLog}`);
    const body: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      messages: prepareMessagesForCache(pruned.messages),
      stream: true,
      ...(tools && tools.length > 0 ? { temperature: cfg.agentTemperature } : {}),
    };

    if (pruned.systemPrompt) {
      body.system = buildSystemBlocks(pruned.systemPrompt);
    }

    if (tools && tools.length > 0) {
      body.tools = prepareToolsForCache(tools);
    }

    // Pre-check against the last known rate-limit budget. sidecarFetch
    // waits the computed time (if any), or throws RateLimitWaitTooLongError
    // when the wait would exceed MAX_RATE_LIMIT_WAIT_MS — better than burning
    // a retry on a request the server is guaranteed to reject. The store
    // is refreshed from response headers before we inspect `response.ok`,
    // so a 429 still updates the budget for the next wait.
    const response = await sidecarFetch(
      this.messagesUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal,
      },
      {
        rateLimits: this.rateLimits,
        estimatedTokens: estimateRequestTokens(systemPrompt, messages, 8192),
        maxRateLimitWaitMs: MAX_RATE_LIMIT_WAIT_MS,
        parseRateLimitHeaders: parseAnthropicRateLimitHeaders,
        label: 'anthropic',
      },
    );

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
    let accInputTokens = 0;
    let accOutputTokens = 0;
    let accCacheCreate = 0;
    let accCacheRead = 0;

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
            case 'message_start':
              if (event.message?.usage) {
                accInputTokens += event.message.usage.input_tokens ?? 0;
                accOutputTokens += event.message.usage.output_tokens ?? 0;
                accCacheCreate += event.message.usage.cache_creation_input_tokens ?? 0;
                accCacheRead += event.message.usage.cache_read_input_tokens ?? 0;
              }
              break;

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
              if (event.usage) {
                accOutputTokens += event.usage.output_tokens ?? 0;
              }
              if (event.delta?.stop_reason) {
                yield { type: 'stop', stopReason: event.delta.stop_reason };
              }
              break;

            case 'message_stop':
              yield {
                type: 'usage',
                model,
                usage: {
                  inputTokens: accInputTokens,
                  outputTokens: accOutputTokens,
                  cacheCreationInputTokens: accCacheCreate,
                  cacheReadInputTokens: accCacheRead,
                },
              };
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
    const cfg = getConfig();
    const pruned = prunePrompt(systemPrompt, messages, {
      enabled: cfg.promptPruningEnabled,
      maxToolResultTokens: cfg.promptPruningMaxToolResultTokens,
    });
    // v0.62.1 p.2a — observability. Previously PruneStats was
    // computed and discarded; post-mortem diagnosis of "did the
    // pruner eat my error message?" was impossible. Log via
    // console.info so the SideCar output channel captures it.
    const _pruneLog = formatPruneStats(pruned.stats);
    if (_pruneLog) console.info(`[SideCar] ${_pruneLog}`);
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: pruned.messages,
      stream: false,
    };

    if (pruned.systemPrompt) {
      body.system = buildSystemBlocks(pruned.systemPrompt);
    }

    const response = await sidecarFetch(
      this.messagesUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal,
      },
      {
        rateLimits: this.rateLimits,
        estimatedTokens: estimateRequestTokens(pruned.systemPrompt, pruned.messages, maxTokens),
        maxRateLimitWaitMs: MAX_RATE_LIMIT_WAIT_MS,
        parseRateLimitHeaders: parseAnthropicRateLimitHeaders,
        label: 'anthropic',
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Anthropic API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    const data = (await response.json()) as AnthropicResponse;
    if (data.usage) {
      spendTracker.record(model, {
        inputTokens: data.usage.input_tokens ?? 0,
        outputTokens: data.usage.output_tokens ?? 0,
        cacheCreationInputTokens: data.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: data.usage.cache_read_input_tokens ?? 0,
      });
    }
    const textBlock = data.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  }
}
