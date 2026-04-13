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

// --- Registry ---

const BACKENDS: Record<string, ModelBackend> = {
  anthropic: new AnthropicEvalBackend(),
};

/**
 * Pick the first available backend. Preference order:
 *   1. Explicit `SIDECAR_EVAL_BACKEND` env var (one of: anthropic)
 *   2. First backend whose `available()` returns true
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
 * Which model to use for eval. Defaults to the cheapest Anthropic
 * model so running the suite doesn't cost much. Override via
 * `SIDECAR_EVAL_MODEL`.
 */
export function pickModel(backend: ModelBackend): string {
  if (process.env.SIDECAR_EVAL_MODEL) return process.env.SIDECAR_EVAL_MODEL;
  if (backend.name === 'anthropic') return 'claude-haiku-4-5-20251001';
  return '';
}
