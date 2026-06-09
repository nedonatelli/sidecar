// ---------------------------------------------------------------------------
// Direct model call for the eval harness.
//
// We deliberately do NOT go through SideCarClient because:
//   - SideCarClient pulls in the VS Code workspace API (config, secrets,
//     window) which is heavy to set up outside the extension host and
//     exercises code paths irrelevant to prompt evaluation.
//   - The eval harness is a *model-facing* test: we want the shortest
//     possible path from "system prompt + user message" → "response"
//     so any regression we observe is attributable to the prompt or
//     the model, not to middleware.
//
// Today we only implement Anthropic (the backend we have a key for in
// dev). Adding OpenAI / Ollama is a matter of another parallel case
// in the switch below plus a separate env-var probe. The shape of
// `callModel` stays the same.
// ---------------------------------------------------------------------------

export interface CallOptions {
  systemPrompt: string;
  userMessage: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelBackend {
  /** Which env vars / settings need to be set for this backend to run. */
  readonly name: string;
  /** Whether the backend is currently available (API key / daemon present). */
  available(): boolean;
  /** Run one completion. Throws on network / API errors. */
  complete(opts: CallOptions): Promise<string>;
}

// --- Anthropic ---

class AnthropicEvalBackend implements ModelBackend {
  readonly name = 'anthropic';

  available(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async complete(opts: CallOptions): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const body = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.2,
      system: opts.systemPrompt,
      messages: [{ role: 'user', content: opts.userMessage }],
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Anthropic API ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    return text;
  }
}

// --- Ollama ---

class OllamaEvalBackend implements ModelBackend {
  readonly name = 'ollama';
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  }

  available(): boolean {
    // No key required — just a running daemon. The actual reachability
    // check happens at complete() time; we can't do a network probe
    // synchronously here. Treat it as available when the env var is set
    // OR when the default localhost address is implied.
    return true;
  }

  async complete(opts: CallOptions): Promise<string> {
    const body = {
      model: opts.model,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.2,
        num_predict: opts.maxTokens ?? 1024,
        think: false,
      },
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userMessage },
      ],
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Ollama ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      message?: { content?: string };
    };
    return data.message?.content ?? '';
  }
}

// --- OpenAI-compatible (OpenAI, Groq, Fireworks, OpenRouter, Gemini) ---

class OpenAICompatEvalBackend implements ModelBackend {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKeyEnv: string;
  readonly defaultModelId: string;
  private readonly chatPath: string;

  constructor(name: string, baseUrl: string, apiKeyEnv: string, defaultModelId: string, chatPath = '/v1/chat/completions') {
    this.name = name;
    this.baseUrl = baseUrl;
    this.apiKeyEnv = apiKeyEnv;
    this.defaultModelId = defaultModelId;
    this.chatPath = chatPath;
  }

  available(): boolean {
    return Boolean(process.env[this.apiKeyEnv]);
  }

  async complete(opts: CallOptions): Promise<string> {
    const apiKey = process.env[this.apiKeyEnv] ?? '';
    const isReasoningModel = /^o\d/i.test(opts.model) || /^gpt-5/i.test(opts.model);
    const maxTokensKey = isReasoningModel ? 'max_completion_tokens' : 'max_tokens';
    const body = {
      model: opts.model,
      [maxTokensKey]: opts.maxTokens ?? 1024,
      ...(!isReasoningModel && { temperature: opts.temperature ?? 0.2 }),
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userMessage },
      ],
      stream: false,
    };

    const response = await fetch(`${this.baseUrl}${this.chatPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${this.name} API ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

// --- Registry ---

const BACKENDS: Record<string, ModelBackend> = {
  anthropic: new AnthropicEvalBackend(),
  ollama: new OllamaEvalBackend(),
  openai: new OpenAICompatEvalBackend('openai', 'https://api.openai.com', 'OPENAI_API_KEY', 'gpt-4o-mini'),
  groq: new OpenAICompatEvalBackend('groq', 'https://api.groq.com/openai', 'GROQ_API_KEY', 'llama-3.3-70b-versatile'),
  fireworks: new OpenAICompatEvalBackend(
    'fireworks',
    'https://api.fireworks.ai/inference',
    'FIREWORKS_API_KEY',
    'accounts/fireworks/models/deepseek-v4-pro',
  ),
  openrouter: new OpenAICompatEvalBackend(
    'openrouter',
    'https://openrouter.ai/api',
    'OPENROUTER_API_KEY',
    'google/gemini-2.5-flash',
  ),
  // Gemini's OpenAI-compat path is /v1beta/openai/chat/completions (no /v1/).
  gemini: new OpenAICompatEvalBackend(
    'gemini',
    'https://generativelanguage.googleapis.com/v1beta/openai',
    'GEMINI_API_KEY',
    'gemini-2.5-flash',
    '/chat/completions',
  ),
};

/**
 * Pick the first available backend. Preference order:
 *   1. Explicit `SIDECAR_EVAL_BACKEND` env var
 *   2. Anthropic (if key present)
 *   3. Ollama (always reports available)
 *
 * Returns null when nothing is available, so the eval suite can
 * skip cleanly instead of failing in environments without an API
 * key (CI, someone else's clone, etc.).
 */
export function pickBackend(): ModelBackend | null {
  const explicit = process.env.SIDECAR_EVAL_BACKEND;
  if (explicit && BACKENDS[explicit]) {
    const b = BACKENDS[explicit];
    return b.available() ? b : null;
  }
  for (const b of Object.values(BACKENDS)) {
    if (b.available()) return b;
  }
  return null;
}

/**
 * Which model to use for eval. Override via `SIDECAR_EVAL_MODEL`.
 * Defaults fall back to each backend's registered default.
 */
export function pickModel(backend: ModelBackend): string {
  if (process.env.SIDECAR_EVAL_MODEL) return process.env.SIDECAR_EVAL_MODEL;
  if (backend.name === 'anthropic') return 'claude-haiku-4-5-20251001';
  if (backend.name === 'ollama') return 'ministral-3:latest';
  // OpenAI-compat backends carry their default in the registry entry.
  const b = BACKENDS[backend.name];
  return b instanceof OpenAICompatEvalBackend ? b.defaultModelId : '';
}
