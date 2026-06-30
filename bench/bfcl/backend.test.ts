import { describe, it, expect } from 'vitest';
import { ollamaBackend, _normalizeOpenAiStyleForTest as normalize } from './backend.js';
import type { BfclFunctionSchema } from './types.js';

const fn: BfclFunctionSchema = {
  name: 'get_weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

describe('normalizeOpenAiStyle', () => {
  it('handles object-typed arguments', () => {
    const r = normalize([{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }]);
    expect(r).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }]);
  });

  it('parses string-typed (JSON) arguments', () => {
    const r = normalize([{ function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }]);
    expect(r).toEqual([{ name: 'get_weather', args: { city: 'Tokyo' } }]);
  });

  it('falls back to empty args on unparseable string', () => {
    const r = normalize([{ function: { name: 'get_weather', arguments: 'not json' } }]);
    expect(r).toEqual([{ name: 'get_weather', args: {} }]);
  });

  it('drops calls with no function name', () => {
    expect(normalize([{ function: { arguments: { city: 'x' } } }])).toEqual([]);
  });
});

describe('ollamaBackend.callModel (injected fetch — no network)', () => {
  it('sends tools + question and returns normalized calls', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(
        JSON.stringify({
          message: { tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }] },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const backend = ollamaBackend({ model: 'gemma4:e4b', fetchImpl: fakeFetch });
    const calls = await backend.callModel('weather in Paris', [fn]);

    expect(calls).toEqual([{ name: 'get_weather', args: { city: 'Paris' } }]);
    const body = captured!.body as { model: string; tools: unknown[]; messages: unknown[] };
    expect(body.model).toBe('gemma4:e4b');
    expect(body.tools).toHaveLength(1);
    expect(captured!.url).toContain('/api/chat');
  });

  it('returns an empty array when the model emits no tool calls (irrelevance path)', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: { content: 'The capital is Paris.' } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const backend = ollamaBackend({ model: 'gemma4:e4b', fetchImpl: fakeFetch });
    expect(await backend.callModel('capital of France?', [fn])).toEqual([]);
  });

  it('throws on a non-OK response', async () => {
    const fakeFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const backend = ollamaBackend({ model: 'm', fetchImpl: fakeFetch });
    await expect(backend.callModel('q', [fn])).rejects.toThrow(/Ollama 500/);
  });
});
