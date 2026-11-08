import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickBackend } from './backend.js';

// The Ollama eval backend serves prompt.eval.ts and the retrieval judge. Its
// request body is the whole contract with Ollama, so the shape is pinned here.
describe('Ollama eval backend request body (#469)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function capturedBody(): Promise<Record<string, unknown>> {
    vi.stubEnv('SIDECAR_EVAL_BACKEND', 'ollama');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ok' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = pickBackend();
    expect(backend?.name).toBe('ollama');
    await backend!.complete({ model: 'qwen3:8b', systemPrompt: 's', userMessage: 'u' });
    return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
  }

  it('sends think:false at the top level, not inside options', async () => {
    // Ollama ignores option keys it doesn't recognise, so `options.think`
    // left thinking on for every eval call.
    const body = await capturedBody();
    expect(body.think).toBe(false);
    expect('think' in (body.options as object)).toBe(false);
  });
});
