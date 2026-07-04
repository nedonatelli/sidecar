/**
 * Model catalog + discovery — the provider-aware "what models exist?" layer of
 * SideCarClient, extracted as free functions so the client class stays focused
 * on the chat/completion path. Covers the installed-model listing per provider,
 * the Ollama pull stream, and cross-backend (Ollama + Kickstand) discovery.
 */

import type { ApiBackend } from '../backend.js';
import { kickstandHeaders } from '../kickstandBackend.js';
import { CopilotBackend } from '../copilotBackend.js';
import { BedrockBackend } from '../bedrockBackend.js';

/** Provider tags SideCarClient can resolve; mirrors `getProviderType()`. */
export type ProviderType =
  | 'ollama'
  | 'anthropic'
  | 'openai'
  | 'kickstand'
  | 'openrouter'
  | 'groq'
  | 'fireworks'
  | 'gemini'
  | 'copilot'
  | 'bedrock';

export interface InstalledModel {
  name: string;
  model: string;
  size?: number;
  digest?: string;
  /**
   * Model context window in tokens, when the backend exposes it. Kickstand
   * reports the loaded `n_ctx` for loaded models and the native GGUF
   * `<arch>.context_length` for unloaded models; Ollama and others leave
   * this undefined (chat-path sizing goes through `getModelContextLength()`).
   */
  contextLength?: number | null;
}

export interface LibraryModel {
  name: string;
  installed: boolean;
  installing?: boolean;
  /** Optional context window (tokens) to surface in the picker. See InstalledModel.contextLength. */
  contextLength?: number | null;
}

export interface PullProgress {
  model: string;
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/** Popular Ollama library models suggested to new users with an empty install. */
export const LIBRARY_MODELS = [
  'llama3',
  'llama3.1',
  'llama3.2',
  'mistral',
  'mixtral',
  'codellama',
  'phi3',
  'qwen2',
  'qwen2.5',
  'qwen3-coder',
  'deepseek-coder',
  'nomic-embed-text',
  'llava',
  'gemma',
  'gemma2',
  'phi',
];

// Fallback Claude model catalog for when /v1/models is unreachable or
// returns an empty list (older keys, proxies that don't expose it).
// Keep this roughly aligned with Anthropic's published current models.
export const ANTHROPIC_FALLBACK_MODELS = [
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
  'claude-3-7-sonnet-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
  'claude-3-opus-latest',
];

// Bedrock has no cheap model-list endpoint (ListFoundationModels needs a
// separate signed call), so the picker shows a static set of common Claude
// model / cross-region inference-profile IDs. Users can type any other Bedrock
// model id into the model input. GovCloud uses the same ids under its partition.
export const BEDROCK_FALLBACK_MODELS = [
  'us.anthropic.claude-sonnet-4-20250514-v1:0',
  'us.anthropic.claude-opus-4-20250514-v1:0',
  'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'anthropic.claude-3-5-haiku-20241022-v1:0',
];

/** Fields the installed-model listing needs from the client instance. */
export interface ModelListContext {
  provider: ProviderType;
  baseUrl: string;
  apiKey: string;
  backend: ApiBackend;
}

/**
 * List the models installed/available for the active provider. Each provider
 * owns its own listing endpoint + auth; unreachable list endpoints fall back to
 * a static catalog (Anthropic/Bedrock) or an empty list rather than throwing.
 */
export async function listInstalledModelsInner(ctx: ModelListContext): Promise<InstalledModel[]> {
  const { provider, baseUrl, apiKey, backend } = ctx;

  if (provider === 'copilot') {
    const models = await CopilotBackend.listAvailableModels();
    return models.map((m) => ({ name: m.name || m.id, model: m.id, size: 0 }));
  }

  if (provider === 'anthropic') {
    const fallback = (): InstalledModel[] => ANTHROPIC_FALLBACK_MODELS.map((id) => ({ name: id, model: id, size: 0 }));
    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!response.ok) return fallback();
      const data = (await response.json()) as { data?: { id: string; display_name?: string }[] };
      const fetched = (data.data || []).map((m) => ({ name: m.id, model: m.id, size: 0 }));
      return fetched.length > 0 ? fetched : fallback();
    } catch {
      return fallback();
    }
  }

  if (provider === 'kickstand') {
    // Kickstand's full registry — `/api/v1/models` — surfaces every
    // downloaded model (loaded or not) plus GGUF-derived
    // `context_length` for unloaded entries. The OAI `/v1/models`
    // only reports loaded models, which would hide the user's real
    // library in the picker. We filter on `status === 'ready'` so
    // in-flight downloads don't pollute the dropdown.
    try {
      const response = await fetch(`${baseUrl}/api/v1/models`, {
        headers: await kickstandHeaders(),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as Array<{
        model_id: string;
        size_bytes?: number | null;
        status?: string;
        context_length?: number | null;
      }>;
      return (data || [])
        .filter((m) => m.status === 'ready' || m.status === undefined)
        .map((m) => ({
          name: m.model_id,
          model: m.model_id,
          size: m.size_bytes ?? 0,
          contextLength: typeof m.context_length === 'number' ? m.context_length : null,
        }));
    } catch {
      return [];
    }
  }

  if (provider === 'bedrock') {
    // Prefer a live query of the Bedrock control plane (ListInferenceProfiles
    // + ListFoundationModels, Anthropic-only). Falls back to a static list
    // when the call fails — e.g. a Bedrock API key scoped only to InvokeModel,
    // or no list permission. The runtime host has no /api/tags or /v1/models,
    // so we never probe baseUrl here.
    if (backend instanceof BedrockBackend) {
      const live = await backend.listAnthropicModels().catch(() => [] as string[]);
      if (live.length > 0) return live.map((id) => ({ name: id, model: id, size: 0 }));
    }
    return BEDROCK_FALLBACK_MODELS.map((id) => ({ name: id, model: id, size: 0 }));
  }

  if (backend.listModels) {
    // OpenAI-compatible backends (openai / openrouter / groq / fireworks /
    // gemini) each own their model-list endpoint + auth. Delegating here —
    // rather than probing a hardcoded `${baseUrl}/v1/models` — is what lets
    // Gemini work: it overrides listModels() to hit its non-standard endpoint,
    // whereas the old inline probe fell through to Ollama's /api/tags and
    // returned nothing. The richer OpenRouter catalog (pricing) stays in
    // OpenRouterBackend.listOpenRouterModels().
    const models = await backend.listModels();
    return models.map((m) => ({
      name: m.id,
      model: m.id,
      size: 0,
      details: { parameter_size: '', quantization_level: '', family: m.owned_by ?? '' },
    }));
  }

  // Ollama uses /api/tags
  const response = await fetch(`${baseUrl}/api/tags`);
  if (!response.ok) {
    throw new Error(`Failed to list models: ${response.status}`);
  }
  const data = (await response.json()) as { models: InstalledModel[] };
  return data.models ?? [];
}

/**
 * Merge an installed-model list with the hardcoded Ollama library suggestions.
 * Suggestions are appended (marked `installed: false`) only for Ollama and only
 * when `includeSuggestions` is set — the active-model picker passes false so
 * uninstalled entries don't pollute it.
 */
export function buildLibraryModels(
  installed: InstalledModel[],
  provider: ProviderType,
  includeSuggestions: boolean,
): LibraryModel[] {
  const installedNames = new Set(installed.map((m) => m.name.split(':')[0]));
  const results: LibraryModel[] = installed.map((m) => ({
    name: m.name,
    installed: true,
    contextLength: m.contextLength ?? null,
  }));

  if (includeSuggestions && provider === 'ollama') {
    for (const name of LIBRARY_MODELS) {
      if (!installedNames.has(name)) {
        results.push({ name, installed: false });
      }
    }
  }

  return results;
}

/** Stream Ollama's `/api/pull` progress for a model. */
export async function* pullModelStream(
  pullUrl: string,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<PullProgress> {
  const response = await fetch(pullUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to pull model: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Pull returned an empty response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder
        .decode(value, { stream: true })
        .split('\n')
        .filter((line) => line.trim());

      for (const line of lines) {
        try {
          yield JSON.parse(line) as PullProgress;
        } catch {
          // Skip malformed lines
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      reader.releaseLock();
    }
  }
}

/**
 * Discover and merge available models from both Ollama and Kickstand backends.
 * Probes each at its base URL with a 2-second timeout; an unreachable backend
 * is skipped silently. Deduplicates by model name.
 *
 * @param ollamaUrl   Base URL for Ollama (default: http://localhost:11434)
 * @param kickstandUrl Base URL for Kickstand (default: http://localhost:11435)
 */
export async function discoverAllAvailableModels(
  ollamaUrl = 'http://localhost:11434',
  kickstandUrl = 'http://localhost:11435',
): Promise<InstalledModel[]> {
  const models: InstalledModel[] = [];
  const seen = new Set<string>();

  // Try Ollama
  try {
    const url = ollamaUrl.replace(/\/+$/, '');
    const ollamaResponse = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (ollamaResponse.ok) {
      const data = (await ollamaResponse.json()) as { models: InstalledModel[] };
      if (data.models) {
        for (const m of data.models) {
          if (!seen.has(m.name)) {
            models.push(m);
            seen.add(m.name);
          }
        }
      }
    }
  } catch {
    // Ollama not available, continue
  }

  // Try Kickstand
  try {
    const url = kickstandUrl.replace(/\/+$/, '');
    const llmmResponse = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (llmmResponse.ok) {
      const data = (await llmmResponse.json()) as { data: { id: string; owned_by?: string }[] };
      if (data.data) {
        for (const m of data.data) {
          if (!seen.has(m.id)) {
            models.push({
              name: m.id,
              model: m.id,
            });
            seen.add(m.id);
          }
        }
      }
    }
  } catch {
    // Kickstand not available, continue
  }

  return models;
}
