import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ApiBackend, BackendCapabilities } from './backend.js';
import type { ChatMessage, ContentBlock, ToolDefinition, StreamEvent } from './types.js';
import { streamOpenAiSse } from './openAiSseStream.js';
import { RateLimitStore } from './rateLimitState.js';
import { parseOpenAIRateLimitHeaders } from './rateLimitHeaders.js';
import { sidecarFetch } from './sidecarFetch.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';

/**
 * Read the auto-generated Kickstand bearer token from the well-known
 * file path (`~/.config/kickstand/token`). Kickstand creates this file
 * on first run — SideCar reads it silently so the user never has to
 * copy-paste a key. Returns an empty string if the file doesn't exist
 * (e.g. Kickstand hasn't been started yet).
 */
function readKickstandToken(): string {
  try {
    const tokenPath = path.join(os.homedir(), '.config', 'kickstand', 'token');
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, 'utf-8').trim();
    }
  } catch {
    // Token file not found or unreadable — Kickstand may not be installed
  }
  return '';
}

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
    private nCtx: number = 32768,
  ) {}

  getRateLimits(): RateLimitStore {
    return this.rateLimits;
  }

  private get chatUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  /** Returns true when Kickstand rejected the request because the loaded model's n_ctx is too small. */
  private isContextOverflowError(status: number, body: string): boolean {
    return status === 400 && body.toLowerCase().includes('load model with larger n_ctx');
  }

  /** Returns true when Kickstand rejected the request because the model isn't loaded yet. */
  private isModelNotLoadedError(status: number, body: string): boolean {
    return status === 404 && body.toLowerCase().includes('model not loaded');
  }

  /**
   * Unload + reload `model` with `this.nCtx`. Called automatically when a
   * chat request hits the context-overflow 400 so the user doesn't have to
   * manually reload via the command palette after adjusting nCtx.
   */
  private async reloadWithLargerCtx(model: string): Promise<void> {
    await kickstandUnloadModel(this.baseUrl, model).catch(() => {});
    await kickstandLoadModel(this.baseUrl, model, { n_ctx: this.nCtx });
  }

  /** Load `model` with `this.nCtx`. Called when a chat request returns 404 model-not-loaded. */
  private async loadModel(model: string): Promise<void> {
    await kickstandLoadModel(this.baseUrl, model, { n_ctx: this.nCtx });
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = readKickstandToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
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

    const fetchOpts = {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal,
    };
    const rateLimitOpts = {
      rateLimits: this.rateLimits,
      estimatedTokens: estimateRequestTokens(systemPrompt, messages, 4096),
      maxRateLimitWaitMs: MAX_RATE_LIMIT_WAIT_MS,
      parseRateLimitHeaders: parseOpenAIRateLimitHeaders,
      label: 'kickstand',
    };

    let response = await sidecarFetch(this.chatUrl, fetchOpts, rateLimitOpts);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      if (this.isContextOverflowError(response.status, errorText)) {
        await this.reloadWithLargerCtx(model);
        response = await sidecarFetch(this.chatUrl, { ...fetchOpts, headers: this.getHeaders() }, rateLimitOpts);
      } else if (this.isModelNotLoadedError(response.status, errorText)) {
        await this.loadModel(model);
        response = await sidecarFetch(this.chatUrl, { ...fetchOpts, headers: this.getHeaders() }, rateLimitOpts);
      }
      if (!response.ok) {
        const retryText = await response.text().catch(() => errorText);
        throw new Error(`Kickstand API error ${response.status}: ${retryText}`);
      }
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

    const fetchOpts = {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
      signal,
    };
    const rateLimitOpts = {
      rateLimits: this.rateLimits,
      estimatedTokens: estimateRequestTokens(systemPrompt, messages, maxTokens),
      maxRateLimitWaitMs: MAX_RATE_LIMIT_WAIT_MS,
      parseRateLimitHeaders: parseOpenAIRateLimitHeaders,
      label: 'kickstand',
    };

    let response = await sidecarFetch(this.chatUrl, fetchOpts, rateLimitOpts);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      if (this.isContextOverflowError(response.status, errorText)) {
        await this.reloadWithLargerCtx(model);
        response = await sidecarFetch(this.chatUrl, { ...fetchOpts, headers: this.getHeaders() }, rateLimitOpts);
      } else if (this.isModelNotLoadedError(response.status, errorText)) {
        await this.loadModel(model);
        response = await sidecarFetch(this.chatUrl, { ...fetchOpts, headers: this.getHeaders() }, rateLimitOpts);
      }
      if (!response.ok) {
        const retryText = await response.text().catch(() => errorText);
        throw new Error(`Kickstand API error ${response.status}: ${retryText}`);
      }
    }

    const data: KickstandChatResponse = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  /**
   * Declare Kickstand's native lifecycle capability (v0.63.1).
   * Wraps the module-level `kickstandLoadModel` / `kickstandUnloadModel`
   * / `kickstandListRegistry` helpers that already speak Kickstand's
   * `/api/v1/models/*` endpoints — this method just attributes them
   * as a capability other parts of SideCar (command palette, future
   * model browser) can introspect and invoke.
   */
  nativeCapabilities(): BackendCapabilities {
    return {
      lifecycle: {
        loadModel: async (id, _opts) => {
          // `_opts.timeoutMs` from the capability interface is
          // reserved for future use — Kickstand's load endpoint
          // doesn't accept a per-request timeout today, so the
          // parameter is prefixed with `_` to satisfy the lint
          // rule while we wait for Kickstand to grow the option.
          const loadOpts = { n_gpu_layers: undefined as number | undefined, n_ctx: this.nCtx };
          try {
            const result = await kickstandLoadModel(this.baseUrl, id, loadOpts);
            return result.socket ? `Loaded ${result.model_id} (socket: ${result.socket})` : `Loaded ${result.model_id}`;
          } catch (err) {
            if (!isVramError(err)) throw err;
            // Not enough VRAM — unload every currently-loaded model and retry.
            const registry = await kickstandListRegistry(this.baseUrl);
            const loaded = registry.filter((m) => m.loaded && m.model_id !== id);
            await Promise.all(loaded.map((m) => kickstandUnloadModel(this.baseUrl, m.model_id).catch(() => {})));
            const result = await kickstandLoadModel(this.baseUrl, id, loadOpts);
            const evicted = loaded.map((m) => m.model_id).join(', ');
            const base = result.socket
              ? `Loaded ${result.model_id} (socket: ${result.socket})`
              : `Loaded ${result.model_id}`;
            return evicted ? `${base} (evicted: ${evicted})` : base;
          }
        },
        unloadModel: async (id) => {
          const result = await kickstandUnloadModel(this.baseUrl, id);
          return `Unloaded ${result.model_id}`;
        },
        listLoadable: async () => {
          const registry = await kickstandListRegistry(this.baseUrl);
          return registry.map((m) => ({
            id: m.model_id,
            loaded: m.loaded,
            sizeBytes: m.size_bytes ?? undefined,
          }));
        },
      },
      loraAdapters: {
        listAdapters: async (modelId: string) => {
          return kickstandListAdapters(this.baseUrl, modelId);
        },
        loadAdapter: async (modelId: string, adapterPath: string, scale?: number) => {
          const result = await kickstandLoadAdapter(this.baseUrl, modelId, adapterPath, scale);
          return `Loaded LoRA ${result.adapter_id} on ${modelId}`;
        },
        unloadAdapter: async (modelId: string, adapterId: string) => {
          await kickstandUnloadAdapter(this.baseUrl, modelId, adapterId);
          return `Unloaded LoRA ${adapterId} from ${modelId}`;
        },
      },
      modelBrowser: {
        browseRepo: async (repo: string) => {
          return kickstandBrowseRepo(this.baseUrl, repo);
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Kickstand model management (pull, load, unload, registry list)
// ---------------------------------------------------------------------------

export function kickstandHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = readKickstandToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/** Progress event emitted by {@link kickstandPullModel}. */
export interface KickstandPullEvent {
  status: 'downloading' | 'progress' | 'done' | 'error';
  repo?: string;
  filename?: string;
  format?: string;
  local_path?: string;
  message?: string;
  bytes_done?: number;
  bytes_total?: number;
  percent?: number;
}

/**
 * Strip a full HuggingFace URL down to its `owner/repo` path segment so
 * callers can accept either form without the server rejecting the URL.
 */
export function normalizeHfRepo(input: string): string {
  return input.replace(/^https?:\/\/huggingface\.co\//i, '').replace(/\/+$/, '');
}

/**
 * Pull a model from HuggingFace via Kickstand's `/api/v1/models/pull` SSE
 * endpoint. Yields progress events as they arrive. The caller should
 * display status updates and stop on `done` or `error`.
 */
export async function* kickstandPullModel(
  baseUrl: string,
  repo: string,
  filename?: string,
  hfToken?: string,
  signal?: AbortSignal,
): AsyncGenerator<KickstandPullEvent> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models/pull`;
  const body: Record<string, unknown> = { repo };
  if (filename) body.filename = filename;
  if (hfToken) body.token = hfToken;

  const response = await fetch(url, {
    method: 'POST',
    headers: kickstandHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    yield { status: 'error', message: `Kickstand pull failed (${response.status}): ${text}` };
    return;
  }

  if (!response.body) {
    yield { status: 'error', message: 'Kickstand returned an empty response body' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const json = trimmed.slice(5).trim();
        if (!json) continue;
        try {
          yield JSON.parse(json) as KickstandPullEvent;
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Model entry from Kickstand's registry list. */
export interface KickstandRegistryModel {
  model_id: string;
  hf_repo: string;
  filename: string;
  quant: string | null;
  size_bytes: number | null;
  local_path: string;
  status: 'ready' | 'downloading' | 'error';
  format: 'gguf' | 'mlx';
  loaded: boolean;
  /**
   * For loaded models, the runtime `n_ctx` the worker was started with.
   * For unloaded GGUF models, the native `<arch>.context_length` read from
   * the file's metadata. `null`/undefined when Kickstand couldn't determine it
   * (e.g. non-GGUF unloaded model, corrupt metadata).
   */
  context_length?: number | null;
}

/** Returns true for a thrown error from kickstandLoadModel that indicates insufficient VRAM (HTTP 507). */
function isVramError(err: unknown): boolean {
  return err instanceof Error && /load failed \(507\)/i.test(err.message);
}

/** List all models in Kickstand's registry (downloaded + loaded state). */
export async function kickstandListRegistry(baseUrl: string): Promise<KickstandRegistryModel[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models`;
  const response = await fetch(url, { headers: kickstandHeaders(), signal: AbortSignal.timeout(5000) });
  if (!response.ok) return [];
  return (await response.json()) as KickstandRegistryModel[];
}

/** Load a model into GPU memory. */
export async function kickstandLoadModel(
  baseUrl: string,
  modelId: string,
  opts: { n_gpu_layers?: number; n_ctx?: number } = {},
): Promise<{ status: string; model_id: string; socket?: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models/${encodeURIComponent(modelId)}/load`;
  const response = await fetch(url, {
    method: 'POST',
    headers: kickstandHeaders(),
    body: JSON.stringify({ n_gpu_layers: opts.n_gpu_layers ?? -1, n_ctx: opts.n_ctx ?? 4096 }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Kickstand load failed (${response.status}): ${text}`);
  }
  return response.json();
}

/** Unload a model from GPU memory. */
export async function kickstandUnloadModel(
  baseUrl: string,
  modelId: string,
): Promise<{ status: string; model_id: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models/${encodeURIComponent(modelId)}/unload`;
  const response = await fetch(url, {
    method: 'POST',
    headers: kickstandHeaders(),
    body: '{}',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Kickstand unload failed (${response.status}): ${text}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// LoRA adapter management
// ---------------------------------------------------------------------------

/** List LoRA adapters loaded on a model. */
export async function kickstandListAdapters(
  baseUrl: string,
  modelId: string,
): Promise<{ id: string; path: string; scale: number }[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models/${encodeURIComponent(modelId)}/lora`;
  const response = await fetch(url, { headers: kickstandHeaders(), signal: AbortSignal.timeout(5000) });
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data) ? data : (data.adapters ?? []);
}

/** Load a LoRA adapter onto a loaded model. */
export async function kickstandLoadAdapter(
  baseUrl: string,
  modelId: string,
  adapterPath: string,
  scale: number = 1.0,
): Promise<{ adapter_id: string; status: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models/${encodeURIComponent(modelId)}/lora`;
  const response = await fetch(url, {
    method: 'POST',
    headers: kickstandHeaders(),
    body: JSON.stringify({ path: adapterPath, scale }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LoRA load failed (${response.status}): ${text}`);
  }
  return response.json();
}

/** Unload a LoRA adapter from a model. */
export async function kickstandUnloadAdapter(
  baseUrl: string,
  modelId: string,
  adapterId: string,
): Promise<{ status: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models/${encodeURIComponent(modelId)}/lora/${encodeURIComponent(adapterId)}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: kickstandHeaders(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`LoRA unload failed (${response.status}): ${text}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Model browser (HuggingFace repo browsing via Kickstand)
// ---------------------------------------------------------------------------

/** Browse GGUF/MLX files in a HuggingFace repo via Kickstand's browse endpoint. */
export async function kickstandBrowseRepo(
  baseUrl: string,
  repo: string,
): Promise<{ filename: string; sizeBytes: number; quant?: string; format: string }[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/models/browse/${repo}`;
  const response = await fetch(url, { headers: kickstandHeaders(), signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Browse failed (${response.status}): ${text}`);
  }
  const data: { filename: string; size_bytes: number; quant: string | null; format: string }[] = await response.json();
  return data.map((f) => ({
    filename: f.filename,
    sizeBytes: f.size_bytes,
    quant: f.quant ?? undefined,
    format: f.format,
  }));
}
