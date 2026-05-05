import { OpenAIBackend } from './openaiBackend.js';
import { RateLimitStore } from './rateLimitState.js';
import { sidecarFetch } from './sidecarFetch.js';

/**
 * Google Gemini backend via the OpenAI-compatible endpoint.
 *
 * Gemini exposes a drop-in /openai/v1/chat/completions surface at
 * generativelanguage.googleapis.com/openai — same wire format as OpenAI,
 * same Bearer-token auth. No custom headers or body fields required.
 * A thin subclass is enough; all stream parsing reuses OpenAIBackend.
 *
 * Configure the profile with:
 *   baseUrl: 'https://generativelanguage.googleapis.com/openai'
 *   apiKey:  your Google AI Studio key
 *   model:   'gemini-2.0-flash' | 'gemini-1.5-pro' | ...
 */
export class GeminiBackend extends OpenAIBackend {
  constructor(baseUrl: string, apiKey: string, rateLimits: RateLimitStore = new RateLimitStore()) {
    super(baseUrl, apiKey, rateLimits);
  }

  /** List models available for the current API key via the Gemini models endpoint. */
  async listModels(): Promise<{ id: string; owned_by?: string }[]> {
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + this.apiKey;
      const resp = await sidecarFetch(url, { method: 'GET' });
      if (!resp.ok) return GEMINI_DEFAULT_MODELS.map((id) => ({ id, owned_by: 'google' }));
      const json = (await resp.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
      if (!json.models) return GEMINI_DEFAULT_MODELS.map((id) => ({ id, owned_by: 'google' }));
      return json.models
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => ({ id: m.name.replace('models/', ''), owned_by: 'google' }))
        .filter((m) => m.id.startsWith('gemini'));
    } catch {
      return GEMINI_DEFAULT_MODELS.map((id) => ({ id, owned_by: 'google' }));
    }
  }
}

/** Fallback model list when the API key isn't available at startup. */
export const GEMINI_DEFAULT_MODELS = [
  'gemini-2.5-flash-preview-04-17',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
];
