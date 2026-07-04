import type { ApiBackend } from './backend.js';
import { logger } from '../system/logger.js';
import type {
  ChatMessage,
  ContentBlock,
  ToolDefinition,
  AnthropicResponse,
  AnthropicStreamEvent,
  StreamEvent,
} from './types.js';
import { getConfig } from '../config/settings.js';
import { abortableRead } from './streamUtils.js';
import { RateLimitStore } from './rateLimitState.js';
import { parseAnthropicRateLimitHeaders } from './rateLimitHeaders.js';
import { sidecarFetch } from './sidecarFetch.js';
import { translateAnthropicStream } from './anthropicStreamTranslate.js';
import { spendTracker } from './spendTracker.js';
import { prunePrompt, formatPruneStats } from './promptPruner.js';
import { estimateRequestTokens } from '../config/tokenEstimation.js';

/** How long we'll wait on a rate-limit reset before telling the user to switch backends. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * Explicit allow-list of Claude model prefixes that accept `temperature`.
 * Claude 4.x+ deprecated the parameter; defaulting to false for unrecognized
 * model IDs prevents accidental injection into future versions.
 */
const TEMPERATURE_SUPPORTED_PREFIXES = [
  'claude-3-opus',
  'claude-3-sonnet',
  'claude-3-haiku',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-7-sonnet',
];

/**
 * Per-model output token ceilings as documented by Anthropic.
 * Keyed by model-id prefix (longest match wins if multiple apply).
 * Used to clamp `max_tokens` before sending — the API hard-rejects
 * any value above the model's ceiling.
 */
const ANTHROPIC_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'claude-opus-4': 32_000,
  'claude-sonnet-4': 64_000,
  'claude-haiku-4': 64_000,
  'claude-3-7-sonnet': 64_000,
  'claude-3-5-sonnet': 8_192,
  'claude-3-5-haiku': 8_192,
  'claude-3-opus': 4_096,
  'claude-3-sonnet': 4_096,
  'claude-3-haiku': 4_096,
};

export function maxOutputTokensForModel(model: string): number {
  const lower = model.toLowerCase();
  const match = Object.keys(ANTHROPIC_MAX_OUTPUT_TOKENS)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => lower.startsWith(prefix));
  return match ? ANTHROPIC_MAX_OUTPUT_TOKENS[match] : 64_000;
}

export function supportsTemperature(model: string): boolean {
  const lower = model.toLowerCase();
  return TEMPERATURE_SUPPORTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
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
  // Split into stable prefix (cached) and dynamic workspace context (not cached)
  const stablePrefix = markerIndex > 0 ? systemPrompt.slice(0, markerIndex).trimEnd() : '';
  const dynamicContext = systemPrompt.slice(markerIndex);
  if (!stablePrefix) {
    // No stable prefix (marker absent or at position 0) — cache the whole prompt.
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  }
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
  return tools.map((tool, i) => {
    // Strip internal SideCar fields (nondeterministicOutput) before sending to
    // Anthropic — the API rejects unknown top-level fields on tool definitions.
    const { nondeterministicOutput: _nd, ...apiTool } = tool;
    return i === tools.length - 1
      ? ({ ...apiTool, cache_control: { type: 'ephemeral' } } as ToolDefinition)
      : (apiTool as ToolDefinition);
  });
}

/**
 * Mark the last content block of the last assistant message with
 * `cache_control`, so prior conversation history is cached across agent
 * iterations. In a well-formed agent-loop history, the last assistant
 * message is always second-to-last overall (the final message is the
 * current user turn). Placing the boundary here means only that final
 * user message — typically tool results, reliably ≥1,024 tokens — is
 * sent uncached, while the assistant's (potentially large) tool_use
 * blocks from the previous turn enter the cached prefix immediately.
 *
 * Returns a new array; original messages are not mutated. Content is
 * normalized from string → text-block form on the marked message so
 * cache_control can attach to a block.
 */
export function prepareMessagesForCache(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length < 3) return messages;

  // Scan backwards for the last assistant message.
  let targetIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx === -1) return messages;

  const result = messages.slice();
  const target = result[targetIdx];
  const content = target.content;

  const cached = { cache_control: { type: 'ephemeral' } };
  if (typeof content === 'string') {
    result[targetIdx] = {
      ...target,
      content: [{ type: 'text', text: content, ...cached } as ContentBlock],
    };
  } else if (Array.isArray(content) && content.length > 0) {
    const newBlocks = content.slice();
    const last = newBlocks[newBlocks.length - 1];
    newBlocks[newBlocks.length - 1] = { ...last, ...cached } as ContentBlock;
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
    const dedupExemptTools = tools
      ? new Set(tools.filter((t) => t.nondeterministicOutput).map((t) => t.name))
      : undefined;
    const pruned = prunePrompt(systemPrompt, messages, {
      enabled: cfg.promptPruningEnabled,
      maxToolResultTokens: cfg.promptPruningMaxToolResultTokens,
      dedupExemptTools,
    });
    // observability. Previously PruneStats was
    // computed and discarded; post-mortem diagnosis of "did the
    // pruner eat my error message?" was impossible. Log via
    // console.info so the SideCar output channel captures it.
    const _pruneLog = formatPruneStats(pruned.stats);
    if (_pruneLog) logger.info(`[SideCar] ${_pruneLog}`);
    const maxOutputTokens = Math.min(cfg.agentMaxTokens, maxOutputTokensForModel(model));
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxOutputTokens,
      messages: prepareMessagesForCache(pruned.messages),
      stream: true,
      ...(supportsTemperature(model) ? { temperature: cfg.agentTemperature } : {}),
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
        estimatedTokens: estimateRequestTokens(systemPrompt, messages, maxOutputTokens),
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

    // Parse the SSE byte stream into raw Anthropic events; the shared
    // translator turns those into SideCar StreamEvents. Bedrock reuses the
    // same translator over its (base64-unwrapped) event-stream frames.
    async function* parseSse(): AsyncGenerator<AnthropicStreamEvent> {
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
            try {
              yield JSON.parse(data) as AnthropicStreamEvent;
            } catch {
              continue;
            }
          }
        }
      } finally {
        try {
          reader.cancel().catch(() => {});
        } catch {
          reader.releaseLock();
        }
      }
    }

    yield* translateAnthropicStream(parseSse(), model);
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
    // observability. Previously PruneStats was
    // computed and discarded; post-mortem diagnosis of "did the
    // pruner eat my error message?" was impossible. Log via
    // console.info so the SideCar output channel captures it.
    const _pruneLog = formatPruneStats(pruned.stats);
    if (_pruneLog) logger.info(`[SideCar] ${_pruneLog}`);
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

  async completeFIM(
    model: string,
    prefix: string,
    suffix: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    // FIM via prompt wrapping: present prefix + suffix as context and ask for completion
    const systemPrompt =
      'You are a code completion engine. Complete the code between the prefix and suffix sections. Output ONLY the completion text — no explanations, no code fences, no markdown.';
    const userMessage = [
      '<prefix>',
      prefix,
      '</prefix>',
      '',
      '<suffix>',
      suffix,
      '</suffix>',
      '',
      'Complete the code that goes between prefix and suffix:',
    ].join('\n');

    return this.complete(model, systemPrompt, [{ role: 'user', content: userMessage }], maxTokens, signal);
  }
}
