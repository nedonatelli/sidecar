/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterBackend } from './openrouterBackend';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OpenRouterBackend', () => {
  let backend: OpenRouterBackend;

  beforeEach(() => {
    backend = new OpenRouterBackend('https://openrouter.ai/api/v1', 'sk-or-test-key');
    mockFetch.mockReset();
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  describe('listOpenRouterModels', () => {
    it('returns the catalog data field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'anthropic/claude-sonnet-4.5',
              name: 'Claude Sonnet 4.5',
              context_length: 200_000,
              pricing: { prompt: '0.000003', completion: '0.000015' },
            },
            {
              id: 'openai/gpt-4o',
              context_length: 128_000,
              pricing: { prompt: '0.0000025', completion: '0.00001' },
            },
          ],
        }),
      });

      const models = await backend.listOpenRouterModels();
      expect(models).toHaveLength(2);
      expect(models[0].id).toBe('anthropic/claude-sonnet-4.5');
      expect(models[0].context_length).toBe(200_000);
      expect(models[0].pricing?.prompt).toBe('0.000003');
    });

    it('returns [] when the catalog fetch fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
      const models = await backend.listOpenRouterModels();
      expect(models).toEqual([]);
    });

    it('returns [] when fetch throws (network error, DNS failure, etc.)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ENETUNREACH'));
      const models = await backend.listOpenRouterModels();
      expect(models).toEqual([]);
    });

    it('returns [] when the response has no data field', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
      const models = await backend.listOpenRouterModels();
      expect(models).toEqual([]);
    });

    it('sends HTTP-Referer and X-Title headers with the catalog request', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
      await backend.listOpenRouterModels();
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['HTTP-Referer']).toBe('https://github.com/nedonatelli/sidecar');
      expect(init.headers['X-Title']).toBe('SideCar');
    });
  });

  describe('header injection into chat requests', () => {
    it('attaches HTTP-Referer and X-Title to every chat call', async () => {
      // Mock a minimal SSE body: one text chunk + [DONE].
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = JSON.stringify({
            choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
          });
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body,
        headers: new Headers(),
      });

      const events: any[] = [];
      for await (const event of backend.streamChat('anthropic/claude-sonnet-4.5', '', [
        { role: 'user', content: 'hi' },
      ])) {
        events.push(event);
      }

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers['HTTP-Referer']).toBe('https://github.com/nedonatelli/sidecar');
      expect(init.headers['X-Title']).toBe('SideCar');
      expect(init.headers['Authorization']).toBe('Bearer sk-or-test-key');
      // Normal event flow still works: we got the text + stop events.
      expect(events.some((e) => e.type === 'text')).toBe(true);
      expect(events.some((e) => e.type === 'stop')).toBe(true);
    });
  });
});
