import type { ApiBackend } from './backend.js';
import type { ChatMessage, ContentBlock, ToolDefinition, ToolUseContentBlock, StreamEvent } from './types.js';
import { sidecarFetch } from './sidecarFetch.js';
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
import { TOOL_FAILURE_THRESHOLD, MODEL_PROBE_BATCH_SIZE } from '../config/constants.js';

// ---------------------------------------------------------------------------
// Tool support detection
// ---------------------------------------------------------------------------

/**
 * Cache of model tool support queried from Ollama's /api/show endpoint.
 * true = supports tools, false = does not.
 * Models not in the cache haven't been probed yet — we optimistically
 * assume tool support until proven otherwise (by probing or runtime failure).
 */
const toolCapabilityCache = new Map<string, boolean>();

/**
 * Cache of resolved context lengths (tokens) per model name, populated by
 * probeModelToolSupport which already calls /api/show. Prefers the runtime
 * `num_ctx` from model parameters (set via Modelfile) so a user who customised
 * their model gets the right value; falls back to the native context length
 * baked into the GGUF. null = /api/show didn't report a value.
 */
const numCtxCache = new Map<string, number | null>();

/** Return the cached context length for a model, or null if not yet probed. */
export function getCachedOllamaNumCtx(model: string): number | null {
  return numCtxCache.get(model) ?? null;
}

/**
 * Runtime tool support tracking. If a model is sent tools but never
 * returns tool calls after several attempts, we stop sending tools
 * to avoid wasting context on tool definitions.
 */
const toolSupportFailures = new Map<string, number>();

/**
 * Synchronous check used in the hot path (streamChat).
 * Returns false if the model is known not to support tools (via probe or runtime failure).
 * Returns true if the model is known to support tools OR hasn't been probed yet (optimistic).
 */
function supportsTools(model: string): boolean {
  // Check the probed capability cache first
  const cached = toolCapabilityCache.get(model);
  if (cached === false) return false;

  // Check runtime failure count
  const failures = toolSupportFailures.get(model) || 0;
  return failures < TOOL_FAILURE_THRESHOLD;
}

/**
 * Query Ollama's /api/show endpoint for a model's capabilities.
 * Caches the result so subsequent checks are synchronous.
 * Returns true if the model reports tool support, false otherwise.
 * On network/parse errors, returns true (optimistic — let runtime detection handle it).
 */
export async function probeModelToolSupport(baseUrl: string, model: string): Promise<boolean> {
  // Return cached result if available
  const cached = toolCapabilityCache.get(model);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      // Model might not be installed yet — don't cache, stay optimistic
      return true;
    }

    const data = (await response.json()) as {
      capabilities?: string[];
      parameters?: string;
      model_info?: Record<string, unknown>;
    };
    const hasTools = Array.isArray(data.capabilities) && data.capabilities.includes('tools');
    toolCapabilityCache.set(model, hasTools);

    // Extract context length while we have the /api/show response.
    // Prefer the runtime num_ctx (reflects Modelfile overrides); fall back to
    // the native GGUF context_length for stock pulls.
    let numCtx: number | null = null;
    if (data.parameters) {
      const match = data.parameters.match(/^num_ctx\s+(\d+)/m);
      if (match) numCtx = parseInt(match[1], 10);
    }
    if (numCtx === null && data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        if (key.toLowerCase().includes('context_length') && typeof value === 'number') {
          numCtx = value;
          break;
        }
      }
    }
    numCtxCache.set(model, numCtx);

    return hasTools;
  } catch {
    // Network error or timeout — stay optimistic
    return true;
  }
}

/**
 * Delete a model from Ollama via DELETE /api/delete.
 * Throws if Ollama returns a non-2xx response.
 */
export async function deleteOllamaModel(baseUrl: string, model: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Failed to delete model "${model}": ${response.status}${errorText ? ` — ${errorText}` : ''}`);
  }

  // Evict capability caches for the deleted model
  toolCapabilityCache.delete(model);
  numCtxCache.delete(model);
  toolSupportFailures.delete(model);
}

/**
 * Probe tool support for multiple models in parallel.
 * Called during model list loading to pre-populate the cache.
 */
export async function probeAllModelToolSupport(baseUrl: string, modelNames: string[]): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const uncached = modelNames.filter((m) => !toolCapabilityCache.has(m));

  // Probe uncached models in parallel (limit concurrency to avoid hammering Ollama)
  const BATCH_SIZE = MODEL_PROBE_BATCH_SIZE;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((m) => probeModelToolSupport(baseUrl, m)));
  }

  for (const name of modelNames) {
    results.set(name, toolCapabilityCache.get(name) ?? true);
  }
  return results;
}

/** Record that a model was sent tools but did not use them. */
export function recordToolFailure(model: string): void {
  const count = (toolSupportFailures.get(model) || 0) + 1;
  toolSupportFailures.set(model, count);
  if (count >= TOOL_FAILURE_THRESHOLD) {
    console.warn(`[SideCar] Model "${model}" has not used tools after ${count} attempts — disabling tool sending`);
  }
}

/** Record that a model successfully used tools (resets failure count). */
export function recordToolSuccess(model: string): void {
  toolSupportFailures.delete(model);
}

/**
 * Synchronous tool support check. Uses probed capabilities + runtime failure tracking.
 * For accurate results, call probeModelToolSupport() first (e.g. during model loading).
 */
export function modelSupportsTools(model: string): boolean {
  return supportsTools(model);
}

// ---------------------------------------------------------------------------
// Ollama native API types
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatChunk {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
}

// ---------------------------------------------------------------------------
// Message format conversion
// ---------------------------------------------------------------------------

/**
 * Convert our internal ChatMessage[] (Anthropic format) to Ollama's message format.
 * Key differences:
 *   - Ollama uses plain string content, not content block arrays
 *   - Tool results are sent as role:"tool" messages
 *   - Tool calls are in message.tool_calls, not content blocks
 */
function toOllamaMessages(messages: ChatMessage[], systemPrompt: string): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Content block array — need to decompose
    const blocks = msg.content as ContentBlock[];

    if (msg.role === 'user') {
      // User messages may contain tool_result blocks (from agent loop)
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      const textBlocks = blocks.filter((b) => b.type === 'text');
      const imageBlocks = blocks.filter((b) => b.type === 'image');

      // Emit tool result messages
      for (const tr of toolResults) {
        if (tr.type === 'tool_result') {
          result.push({ role: 'tool', content: tr.content });
        }
      }

      // Emit text/image as user message
      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        const text = textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const images = imageBlocks
          .filter((b) => b.type === 'image')
          .map((b) => (b.type === 'image' ? b.source.data : ''));
        const userMsg: OllamaMessage = { role: 'user', content: text };
        if (images.length > 0) {
          userMsg.images = images;
        }
        result.push(userMsg);
      }
    } else {
      // Assistant messages may contain text + tool_use blocks
      const textParts: string[] = [];
      const toolCalls: OllamaToolCall[] = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            function: {
              name: block.name,
              arguments: block.input,
            },
          });
        }
      }

      const assistantMsg: OllamaMessage = {
        role: 'assistant',
        content: textParts.join('\n'),
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    }
  }

  return result;
}

/**
 * Convert our ToolDefinition[] to Ollama's tool format.
 */
// ---------------------------------------------------------------------------
// OllamaBackend
// ---------------------------------------------------------------------------

/**
 * Backend for Ollama's native /api/chat endpoint.
 * Uses NDJSON streaming and Ollama's tool call format.
 */
export class OllamaBackend implements ApiBackend {
  constructor(private baseUrl: string) {}

  private get chatUrl(): string {
    return `${this.baseUrl}/api/chat`;
  }

  async *streamChat(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const { agentTemperature, ollamaNumCtx } = getConfig();
    const probedNumCtx = numCtxCache.get(model) ?? null;
    const numCtx = ollamaNumCtx ?? Math.max(probedNumCtx ?? 0, 32_768);
    const options: Record<string, unknown> = { temperature: agentTemperature, num_ctx: numCtx };
    const body: Record<string, unknown> = {
      model,
      messages: toOllamaMessages(messages, systemPrompt),
      stream: true,
      options,
    };

    if (tools && tools.length > 0) {
      if (supportsTools(model)) {
        body.tools = toFunctionTools(tools);
      } else {
        yield {
          type: 'warning',
          message: `⚠️ Model "${model}" does not support tools. Tool calling is disabled for this model.`,
        };
      }
    }

    const response = await sidecarFetch(
      this.chatUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
      { label: 'ollama' },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');

      // If Ollama says the model doesn't support tools, update both caches
      if (response.status === 400 && errorText.includes('does not support tools')) {
        toolCapabilityCache.set(model, false);
        toolSupportFailures.set(model, TOOL_FAILURE_THRESHOLD);
        console.warn(`[SideCar] Model "${model}" does not support tools — disabling tool sending`);
      }

      throw new Error(
        `Ollama request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    if (!response.body) {
      throw new Error('Ollama returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let toolCallCounter = 0;
    let sawToolCall = false;
    const thinkState: ThinkTagState = { insideThinkTag: false };
    const textToolState: TextToolCallState = createTextToolCallState(tools);

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
          if (!trimmed) continue;

          let chunk: OllamaChatChunk;
          try {
            chunk = JSON.parse(trimmed) as OllamaChatChunk;
          } catch {
            continue;
          }

          // Emit text content, parsing <think> tags for reasoning models
          // and intercepting XML-style text tool calls from models that
          // don't use Ollama's native tool_calls field (e.g. qwen3-coder).
          let emittedToolCallThisChunk = false;
          if (chunk.message.content) {
            for (const ev of parseThinkTags(chunk.message.content, thinkState)) {
              if (ev.type === 'text') {
                for (const sub of parseTextToolCallsStream(ev.text, textToolState)) {
                  if (sub.type === 'tool_use') {
                    sawToolCall = true;
                    emittedToolCallThisChunk = true;
                  }
                  yield sub;
                }
              } else {
                yield ev;
              }
            }
          }

          // Emit native tool calls
          if (chunk.message.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              const toolUse: ToolUseContentBlock = {
                type: 'tool_use',
                id: `ollama_tc_${toolCallCounter++}`,
                name: tc.function.name,
                input: tc.function.arguments,
              };
              yield { type: 'tool_use', toolUse };
              emittedToolCallThisChunk = true;
              sawToolCall = true;
            }
          }

          // Emit stop when done.
          // Ollama may set done_reason to 'stop' (clean end), 'length' (max tokens),
          // or omit it entirely when tool calls happen. If we saw any tool calls in
          // this stream, signal 'tool_use' so the agent loop knows to execute them
          // regardless of the underlying done_reason.
          if (chunk.done) {
            let stopReason: string;
            if (sawToolCall || emittedToolCallThisChunk) {
              stopReason = 'tool_use';
            } else if (chunk.done_reason === 'stop' || !chunk.done_reason) {
              stopReason = 'end_turn';
            } else {
              stopReason = chunk.done_reason;
            }
            yield { type: 'stop', stopReason };
          }
        }
      }
      // Drain any text still buffered by the streaming tool-call parser
      // (e.g. a trailing partial marker that never completed into a real block).
      yield* flushTextToolCallsStream(textToolState);

      // If stream ended inside an unclosed <think> tag, the content was already
      // yielded as thinking events. Emit a note so the UI can finalize the block.
      if (thinkState.insideThinkTag) {
        yield { type: 'thinking', thinking: '\n(end of reasoning)' };
      }
    } finally {
      reader.releaseLock();
    }
  }

  async complete(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    _maxTokens: number = 256,
    signal?: AbortSignal,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      messages: toOllamaMessages(messages, systemPrompt),
      stream: false,
    };

    const response = await sidecarFetch(
      this.chatUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
      { label: 'ollama' },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Ollama request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    const data = (await response.json()) as OllamaChatChunk;
    return data.message.content ?? '';
  }

  async completeFIM(
    model: string,
    prefix: string,
    suffix: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const generateUrl = `${this.baseUrl}/api/generate`;
    const response = await sidecarFetch(
      generateUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: prefix,
          suffix,
          stream: false,
          options: { num_predict: maxTokens },
        }),
        signal,
      },
      { label: 'ollama-fim' },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`FIM request failed: ${response.status}${errorText ? ` — ${errorText}` : ''}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response ?? '';
  }
}
