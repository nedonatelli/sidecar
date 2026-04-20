import type { StreamEvent, ToolDefinition, ToolUseContentBlock } from './types.js';
import {
  abortableRead,
  parseThinkTags,
  parseTextToolCallsStream,
  flushTextToolCallsStream,
  createTextToolCallState,
  type ThinkTagState,
  type TextToolCallState,
} from './streamUtils.js';
import { getConfig } from '../config/settings.js';

/**
 * Shared OpenAI-compatible SSE stream reader.
 *
 * Factored out of OpenAIBackend.streamChat so every backend that speaks
 * the `/v1/chat/completions` dialect (OpenAI, Kickstand, OpenRouter,
 * LM Studio, vLLM, llama.cpp, text-generation-webui) can delegate the
 * tricky parts of stream parsing to one place. Handles:
 *
 *   - SSE framing (`data: ...` prefix, `[DONE]` sentinel)
 *   - Incremental `tool_calls` reconstruction keyed by index
 *   - `<think>` tag parsing for thinking models that inline reasoning
 *   - Text-level tool-call interception for models that don't emit
 *     structured `tool_calls` blocks
 *   - `usage` event emission when the request included
 *     `stream_options: { include_usage: true }`
 *   - `finish_reason` → `StreamEvent.stop` translation
 *
 * Protocol quirks that differ between providers (auth headers, request
 * body shape, referrer headers, rate-limit headers) stay on the calling
 * backend — this helper only touches the response side.
 */

/**
 * Counter for synthesizing tool-call ids when the upstream server
 * omits them. Kept module-local so ids stay monotonic across requests
 * within a single session — different backends reusing the same helper
 * don't collide because the ids are local to an in-flight stream.
 */
let toolCallIdCounter = 0;

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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /**
     * OpenRouter-style provider-reported exact cost in USD for this
     * request. Opt-in via `usage: { include: true }` in the request
     * body; OpenRouter docs call this the `cost` field. When present,
     * downstream spend tracking uses it verbatim instead of computing
     * from the static MODEL_COSTS table. v0.64 chunk 5.
     */
    cost?: number;
  };
}

export interface StreamOpenAiSseOptions {
  /** Provider label used in the verbose-mode usage log line. Default: 'openai'. */
  providerLabel?: string;
  /** Prefix used when synthesizing missing tool-call ids. Default: 'openai'. */
  toolCallIdPrefix?: string;
  /**
   * Whether to log actual usage numbers alongside the estimator when
   * verbose mode is on. Default: true. Backends that produce their own
   * usage logs can pass false to suppress the duplicate.
   */
  logUsageInVerbose?: boolean;
  /**
   * When true, throw if the stream ends without a `[DONE]` sentinel.
   * A missing `[DONE]` means the server closed the connection mid-stream —
   * typically a crash or OOM. Default: false.
   */
  requireDoneSignal?: boolean;
  /**
   * Custom error message thrown when `requireDoneSignal` is true and
   * the stream ends without `[DONE]`. Defaults to a generic message.
   */
  prematureEofMessage?: string;
}

/**
 * Consume an OpenAI-compatible SSE response body and yield the
 * normalized `StreamEvent` sequence expected by `SideCarClient`.
 *
 * Caller is responsible for: building the request body, dispatching the
 * HTTP call, updating rate-limit stores from response headers, and
 * closing over any per-request state (prompt pruning, retry policy).
 * This helper only reads the body.
 */
export async function* streamOpenAiSse(
  response: Response,
  model: string,
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
  options: StreamOpenAiSseOptions = {},
): AsyncGenerator<StreamEvent> {
  const providerLabel = options.providerLabel ?? 'openai';
  const toolCallIdPrefix = options.toolCallIdPrefix ?? 'openai';
  const logUsageInVerbose = options.logUsageInVerbose ?? true;
  const requireDoneSignal = options.requireDoneSignal ?? false;
  const prematureEofMessage =
    options.prematureEofMessage ??
    `${providerLabel} connection closed before stream completed — the server may have crashed or run out of memory.`;

  if (!response.body) {
    console.error(`[SideCar] ${providerLabel} API returned an empty response body`);
    throw new Error(`${providerLabel} API returned an empty response body`);
  }

  console.log(`[SideCar] Starting ${providerLabel} SSE stream parsing`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const thinkState: ThinkTagState = { insideThinkTag: false };
  const textToolState: TextToolCallState = createTextToolCallState(tools);

  // Accumulate incremental tool call data keyed by index.
  const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  /** Flush accumulated tool calls as tool_use events. Used on finish and on [DONE]. */
  function* flushToolCalls(): Generator<StreamEvent> {
    for (const [, tc] of pendingToolCalls) {
      if (tc.name) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.arguments || '{}');
        } catch {
          /* malformed args — leave parsedArgs empty so the tool still dispatches */
        }
        const toolUse: ToolUseContentBlock = {
          type: 'tool_use',
          id: tc.id || `${toolCallIdPrefix}_tc_${++toolCallIdCounter}`,
          name: tc.name,
          input: parsedArgs,
        };
        yield { type: 'tool_use', toolUse };
      }
    }
    pendingToolCalls.clear();
  }

  try {
    let buffer = '';
    let sawDone = false;
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
          sawDone = true;
          yield* flushToolCalls();
          continue;
        }

        let chunk: OpenAIChatChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        // Usage-only chunk — emitted as the final chunk when the
        // request body included `stream_options: { include_usage: true }`.
        // choices[] is empty on this chunk; don't treat the absence of a
        // choice as a parse skip.
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
              // Pass through the provider-reported exact cost when present
              // (OpenRouter ships it in `usage.cost`). spendTracker.record
              // prefers this over its price-table computation. v0.64 chunk 5.
              ...(typeof u.cost === 'number' && Number.isFinite(u.cost) ? { costUsd: u.cost } : {}),
            },
          };
          if (logUsageInVerbose && getConfig().verboseMode) {
            console.log(
              `[SideCar ${providerLabel} ${model}] actual usage: ` +
                `prompt=${(u.prompt_tokens ?? 0).toLocaleString()}t · ` +
                `completion=${(u.completion_tokens ?? 0).toLocaleString()}t · ` +
                `total=${(u.total_tokens ?? 0).toLocaleString()}t`,
            );
          }
        }

        if ((chunk as unknown as { error?: { message?: string } }).error) {
          const msg = (chunk as unknown as { error: { message?: string } }).error.message ?? 'Server error';
          throw new Error(`${providerLabel}: ${msg}`);
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Text content: <think> tag parsing plus XML-style text tool-call
        // interception for models that don't emit structured tool_calls.
        if (delta.content) {
          for (const ev of parseThinkTags(delta.content, thinkState)) {
            if (ev.type === 'text') {
              yield* parseTextToolCallsStream(ev.text, textToolState);
            } else {
              yield ev;
            }
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = pendingToolCalls.get(tc.index) || { id: '', name: '', arguments: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            pendingToolCalls.set(tc.index, existing);
          }
        }

        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
          yield* flushToolCalls();
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
    if (requireDoneSignal && !sawDone) {
      throw new Error(prematureEofMessage);
    }
  } finally {
    reader.releaseLock();
  }
}
