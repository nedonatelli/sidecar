import { OpenAIBackend } from './openaiBackend.js';

/**
 * Backend for OpenRouter (https://openrouter.ai).
 *
 * OpenRouter proxies hundreds of models across providers (Anthropic,
 * OpenAI, Google, Mistral, Meta, Cohere, and more) through a single
 * OpenAI-compatible `/v1/chat/completions` endpoint, with one API key
 * and one billing relationship. The streaming protocol is byte-identical
 * to OpenAI's, so this subclass reuses `OpenAIBackend` for all stream
 * parsing and only adds the OpenRouter-specific polish on top:
 *
 *   1. HTTP-Referer + X-Title headers. OpenRouter uses these to
 *      identify traffic on their public leaderboard at
 *      https://openrouter.ai/rankings. Sending them is optional but
 *      courteous — it tells other developers what app is generating
 *      the traffic and helps OpenRouter rank integrations by usage.
 *
 *   2. `listModels()` override that hits the rich catalog endpoint,
 *      which returns per-model `pricing.prompt` / `pricing.completion`
 *      numbers, `context_length`, `top_provider`, and free-tier flags.
 *      This lets the cost tracker show accurate numbers for any model
 *      OpenRouter proxies without having to hand-maintain a static
 *      pricing table.
 */
export class OpenRouterBackend extends OpenAIBackend {
  /** HTTP-Referer value sent on every request. Public repo URL so it's harmless to expose. */
  private static readonly REFERRER = 'https://github.com/nedonatelli/sidecar';
  /** X-Title value sent on every request. Shown in OpenRouter's leaderboard. */
  private static readonly APP_TITLE = 'SideCar';

  protected override extraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': OpenRouterBackend.REFERRER,
      'X-Title': OpenRouterBackend.APP_TITLE,
    };
  }

  /**
   * Fetch the OpenRouter model catalog.
   *
   * Unlike OpenAI's `/v1/models` which returns bare ids, OpenRouter
   * enriches each entry with pricing (USD per token, not per million),
   * context window, the upstream provider, and a moderated flag. We
   * return the raw payload so callers (cost overlay, settings UI,
   * model picker) can all pull what they need.
   */
  async listOpenRouterModels(): Promise<OpenRouterModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, { headers: this.extraHeaders() });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: OpenRouterModel[] };
      return data.data ?? [];
    } catch {
      return [];
    }
  }
}

/**
 * Subset of the OpenRouter `/v1/models` catalog entry we actually use.
 * OpenRouter includes many more fields (description, architecture,
 * per-token prompt fees), but we only need the cost + metadata pieces.
 */
export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    /** USD per prompt token — multiply by 1_000_000 for per-M pricing. */
    prompt?: string;
    /** USD per completion token — multiply by 1_000_000 for per-M pricing. */
    completion?: string;
    request?: string;
    image?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
}
