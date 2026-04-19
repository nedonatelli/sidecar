import type { ApiBackend, BackendCapabilities } from './backend.js';
import type { ChatMessage, ContentBlock, ToolDefinition, StreamEvent } from './types.js';
import { toFunctionTools } from './streamUtils.js';
import { streamOpenAiSse } from './openAiSseStream.js';
import { getConfig } from '../config/settings.js';
import { RateLimitStore } from './rateLimitState.js';
import { parseOpenAIRateLimitHeaders } from './rateLimitHeaders.js';
import { sidecarFetch } from './sidecarFetch.js';
import { prunePrompt, formatPruneStats } from './promptPruner.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';
import { OllamaBackend } from './ollamaBackend.js';

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

/** o1/o3/o4 reasoning models reject `max_tokens`; they require `max_completion_tokens`. */
function maxTokensKey(model: string): 'max_tokens' | 'max_completion_tokens' {
  return /^o\d/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
}

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

// ---------------------------------------------------------------------------
// OpenAI-compatible message types
// ---------------------------------------------------------------------------
//
// The SSE response side (OpenAIChatChunk, OpenAIToolCallDelta, the
// ~180-line streaming parser) lives in openAiSseStream.ts so every
// backend that speaks /v1/chat/completions can share it. This file
// only keeps the request-side message shape and the format conversion.

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
    protected baseUrl: string,
    protected apiKey: string,
    protected rateLimits: RateLimitStore = new RateLimitStore(),
  ) {}

  /** Expose the rate-limit snapshot for status UIs and tests. */
  getRateLimits(): RateLimitStore {
    return this.rateLimits;
  }

  protected get chatUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  protected get modelsUrl(): string {
    return `${this.baseUrl}/v1/models`;
  }

  /**
   * Header hook for subclasses that need to attach provider-specific
   * metadata (e.g. OpenRouter's HTTP-Referer and X-Title identifiers
   * used for their public leaderboard). Returns nothing by default.
   */
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  /**
   * Hook for subclasses to contribute additional top-level request-body
   * fields. Default empty. OpenRouter uses this to include
   * `usage: { include: true }` so the streaming response ships
   * `usage.cost` on the final chunk (v0.64 chunk 5 — provider-reported
   * cost pass-through).
   */
  protected extraBodyFields(): Record<string, unknown> {
    return {};
  }

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.extraHeaders() };
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
    // v0.62.1 p.2a — observability (see Anthropic backend for rationale).
    const _pruneLog = formatPruneStats(pruned.stats);
    if (_pruneLog) console.info(`[SideCar] ${_pruneLog}`);
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
      [maxTokensKey(model)]: MAX_OUTPUT_TOKENS,
      // Ask OpenAI to include `usage` on the final stream chunk so we
      // can emit a StreamUsageEvent and feed spendTracker with real
      // numbers instead of heuristic estimates.
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { temperature: cfg.agentTemperature } : {}),
      ...this.extraBodyFields(),
    };

    if (functionTools) {
      body.tools = functionTools;
    }

    logRequestSizeBreakdown(model, pruned.systemPrompt, openaiMessages, functionTools);

    const response = await sidecarFetch(
      this.chatUrl,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal,
      },
      {
        rateLimits: this.rateLimits,
        estimatedTokens: estimateRequestTokens(pruned.systemPrompt, pruned.messages, MAX_OUTPUT_TOKENS),
        maxRateLimitWaitMs: MAX_RATE_LIMIT_WAIT_MS,
        parseRateLimitHeaders: parseOpenAIRateLimitHeaders,
        label: 'openai',
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `OpenAI API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    yield* streamOpenAiSse(response, model, tools, signal, {
      providerLabel: 'openai',
      toolCallIdPrefix: 'openai',
    });
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
      [maxTokensKey(model)]: maxTokens,
      stream: false,
    };

    const response = await sidecarFetch(
      this.chatUrl,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal,
      },
      {
        rateLimits: this.rateLimits,
        estimatedTokens: estimateRequestTokens(systemPrompt, messages, maxTokens),
        maxRateLimitWaitMs: MAX_RATE_LIMIT_WAIT_MS,
        parseRateLimitHeaders: parseOpenAIRateLimitHeaders,
        label: 'openai',
      },
    );

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

  // --- Native capabilities (v0.63.1) ---
  //
  // OpenAI-compat hosts that are actually Ollama underneath get a
  // fallback to `/api/chat` when the OAI-compat `/v1/chat/completions`
  // path glitches. Probe `/api/tags` lazily on first failure — OpenAI,
  // LM Studio, together.ai, and the cloud OpenAI-compat hosts all
  // return 404 there, so the capability effectively auto-disables.
  //
  // Probe result caches on the instance so we don't round-trip every
  // failure. `null` = not yet probed; `true` = confirmed Ollama;
  // `false` = confirmed non-Ollama (never retry).
  private _ollamaProbeResult: boolean | null = null;
  /** In-flight probe so concurrent `matches` calls share one request. */
  private _ollamaProbePromise: Promise<boolean> | null = null;

  private async probeIsOllama(): Promise<boolean> {
    if (this._ollamaProbeResult !== null) return this._ollamaProbeResult;
    if (this._ollamaProbePromise) return this._ollamaProbePromise;

    this._ollamaProbePromise = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/tags`, {
          method: 'GET',
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) return false;
        // Loose schema check — Ollama's /api/tags returns `{ models: [...] }`.
        // A response that parses as JSON but doesn't match is probably
        // some other server that happens to serve 200 on a generic GET.
        const data = (await response.json().catch(() => null)) as { models?: unknown } | null;
        return Array.isArray(data?.models);
      } catch {
        return false;
      }
    })();

    const result = await this._ollamaProbePromise;
    this._ollamaProbeResult = result;
    this._ollamaProbePromise = null;
    return result;
  }

  /** Lazy Ollama backend used for the fallback. Shares baseUrl. */
  private _ollamaFallback: OllamaBackend | null = null;
  private getOllamaFallback(): OllamaBackend {
    if (!this._ollamaFallback) {
      this._ollamaFallback = new OllamaBackend(this.baseUrl);
    }
    return this._ollamaFallback;
  }

  nativeCapabilities(): BackendCapabilities {
    return {
      oaiCompatFallback: {
        matches: (err: unknown): boolean => {
          // Only retry on signals plausibly caused by the OAI-compat
          // layer glitching (upstream 5xx, proxy errors, malformed
          // responses). Auth errors, abort signals, and 4xx (other
          // than 502+) must NOT trigger a retry — those are real
          // failures the circuit breaker needs to see.
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof Error && err.name === 'AbortError') return false;
          // Match the error-shape our existing OpenAIBackend throws:
          // `OpenAI API request failed: 502 Bad Gateway — …`
          const looksLikeOaiGlitch =
            /\b(502|503|504)\b/.test(message) ||
            /malformed (json|response)/i.test(message) ||
            /empty response body/i.test(message);
          if (!looksLikeOaiGlitch) return false;
          // Final gate: is the host actually Ollama? This is the
          // lazy probe — if it says no, never retry (and never
          // advertise a retry for any future failure either,
          // thanks to the cache).
          // Unfortunately matches() is sync; we can't await the
          // probe here. Kick it off in the background and let the
          // next failure's retry attempt use the cached result.
          // First-failure case: return true optimistically; the
          // actual fallback call will short-circuit if the probe
          // then resolves to false.
          if (this._ollamaProbeResult === false) return false;
          // Fire-and-forget probe to populate the cache for the next
          // failure. Optimistically advertise the fallback on this
          // call — `fallbackStreamChat` awaits the probe and declines
          // if the host isn't actually Ollama.
          void this.probeIsOllama();
          return true;
        },
        fallbackStreamChat: async function* (
          this: OpenAIBackend,
          model: string,
          systemPrompt: string,
          messages: ChatMessage[],
          signal?: AbortSignal,
          tools?: ToolDefinition[],
        ): AsyncGenerator<StreamEvent> {
          // Confirm (or wait on) the probe before actually doing the
          // fallback — avoids a pointless second request against a
          // non-Ollama host.
          const isOllama = await this.probeIsOllama();
          if (!isOllama) {
            throw new Error(`Native Ollama fallback declined: ${this.baseUrl} does not respond like an Ollama host.`);
          }
          yield* this.getOllamaFallback().streamChat(model, systemPrompt, messages, signal, tools);
        }.bind(this),
        fallbackComplete: async (
          model: string,
          systemPrompt: string,
          messages: ChatMessage[],
          maxTokens: number,
          signal?: AbortSignal,
        ): Promise<string> => {
          const isOllama = await this.probeIsOllama();
          if (!isOllama) {
            throw new Error(`Native Ollama fallback declined: ${this.baseUrl} does not respond like an Ollama host.`);
          }
          return this.getOllamaFallback().complete(model, systemPrompt, messages, maxTokens, signal);
        },
      },
    };
  }
}
