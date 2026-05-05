import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiBackend, GEMINI_DEFAULT_MODELS } from './geminiBackend.js';

vi.mock('./sidecarFetch.js', () => ({
  sidecarFetch: vi.fn(),
}));

import { sidecarFetch } from './sidecarFetch.js';

describe('GeminiBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extends OpenAIBackend with the correct base URL', () => {
    const backend = new GeminiBackend('https://generativelanguage.googleapis.com/openai', 'test-key');
    // chatUrl is derived from baseUrl — verify the backend constructed
    expect(backend).toBeDefined();
    expect(backend.getRateLimits()).toBeDefined();
  });

  describe('listModels', () => {
    it('returns parsed Gemini model IDs on success', async () => {
      vi.mocked(sidecarFetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-1.5-pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          ],
        }),
      } as never);

      const backend = new GeminiBackend('https://generativelanguage.googleapis.com/openai', 'key');
      const models = await backend.listModels();

      expect(models).toHaveLength(2);
      expect(models[0]).toMatchObject({ id: 'gemini-2.0-flash', owned_by: 'google' });
      expect(models[1]).toMatchObject({ id: 'gemini-1.5-pro', owned_by: 'google' });
      // embedding model filtered out
      expect(models.find((m) => m.id === 'embedding-001')).toBeUndefined();
    });

    it('returns GEMINI_DEFAULT_MODELS when fetch fails', async () => {
      vi.mocked(sidecarFetch).mockRejectedValueOnce(new Error('network error'));

      const backend = new GeminiBackend('https://generativelanguage.googleapis.com/openai', 'key');
      const models = await backend.listModels();

      expect(models.map((m) => m.id)).toEqual(GEMINI_DEFAULT_MODELS);
      expect(models.every((m) => m.owned_by === 'google')).toBe(true);
    });

    it('returns GEMINI_DEFAULT_MODELS when response is not OK', async () => {
      vi.mocked(sidecarFetch).mockResolvedValueOnce({ ok: false, status: 403 } as never);

      const backend = new GeminiBackend('https://generativelanguage.googleapis.com/openai', 'key');
      const models = await backend.listModels();

      expect(models.map((m) => m.id)).toEqual(GEMINI_DEFAULT_MODELS);
    });

    it('returns GEMINI_DEFAULT_MODELS when models array is missing', async () => {
      vi.mocked(sidecarFetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as never);

      const backend = new GeminiBackend('https://generativelanguage.googleapis.com/openai', 'key');
      const models = await backend.listModels();

      expect(models.map((m) => m.id)).toEqual(GEMINI_DEFAULT_MODELS);
    });
  });
});

describe('Gemini provider detection', () => {
  it('isGemini returns true for generativelanguage.googleapis.com URLs', async () => {
    const { isGemini } = await import('../config/settings.js');
    expect(isGemini('https://generativelanguage.googleapis.com/openai')).toBe(true);
    expect(isGemini('https://api.openai.com')).toBe(false);
    expect(isGemini('https://api.anthropic.com')).toBe(false);
  });

  it('detectProvider returns gemini for the Gemini base URL', async () => {
    const { detectProvider } = await import('../config/settings.js');
    expect(detectProvider('https://generativelanguage.googleapis.com/openai', 'auto')).toBe('gemini');
  });

  it('detectProvider returns gemini when provider is explicitly set', async () => {
    const { detectProvider } = await import('../config/settings.js');
    expect(detectProvider('https://example.com', 'gemini')).toBe('gemini');
  });

  it('BUILT_IN_BACKEND_PROFILES includes a gemini entry', async () => {
    const { BUILT_IN_BACKEND_PROFILES } = await import('../config/settings.js');
    const geminiProfile = BUILT_IN_BACKEND_PROFILES.find((p) => p.id === 'gemini');
    expect(geminiProfile).toBeDefined();
    expect(geminiProfile?.provider).toBe('gemini');
    expect(geminiProfile?.baseUrl).toContain('googleapis.com');
    expect(geminiProfile?.defaultModel).toBe('gemini-2.0-flash');
    expect(geminiProfile?.secretKey).not.toBeNull();
  });
});
