import { describe, it, expect } from 'vitest';
import {
  ollamaBackend,
  normalizeSchema,
  _normalizeOpenAiStyleForTest as normalize,
  parseTextCalls,
} from './backend.js';
import type { BfclFunctionSchema } from './types.js';

const fn: BfclFunctionSchema = {
  name: 'get_weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

describe('normalizeSchema (BFCL types → JSON Schema)', () => {
  it('maps dict/float/tuple and recurses into nested properties + items', () => {
    const out = normalizeSchema({
      type: 'dict',
      properties: {
        amount: { type: 'float' },
        tags: { type: 'array', items: { type: 'string' } },
        coords: { type: 'tuple', items: { type: 'integer' } },
      },
    }) as Record<string, unknown>;
    expect(out.type).toBe('object');
    const props = out.properties as Record<string, { type?: string; items?: { type: string } }>;
    expect(props.amount.type).toBe('number');
    expect(props.tags.type).toBe('array');
    expect(props.coords.type).toBe('array');
    expect(props.coords.items!.type).toBe('integer');
  });

  it('drops an unknown/any type rather than emitting it', () => {
    const out = normalizeSchema({ type: 'any', description: 'whatever' }) as Record<string, unknown>;
    expect('type' in out).toBe(false);
    expect(out.description).toBe('whatever');
  });
});

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

  it('falls back to text-parsed calls when the model emits JSON in content (no native tool_calls)', async () => {
    // qwen2.5-coder:7b and most local coding models via /api/chat return the call
    // as a JSON object in content with tool_calls UNSET.
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ message: { content: '```json\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```' } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const backend = ollamaBackend({ model: 'qwen2.5-coder:7b', fetchImpl: fakeFetch });
    expect(await backend.callModel('weather in Paris', [fn])).toEqual([
      { name: 'get_weather', args: { city: 'Paris' } },
    ]);
  });

  it('prefers native tool_calls over text when both are present', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          message: {
            tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Berlin' } } }],
            content: '```json\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```',
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const backend = ollamaBackend({ model: 'm', fetchImpl: fakeFetch });
    expect(await backend.callModel('q', [fn])).toEqual([{ name: 'get_weather', args: { city: 'Berlin' } }]);
  });

  it('rawParsing mode reports the raw model only (no text recovery)', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ message: { content: '```json\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```' } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const backend = ollamaBackend({ model: 'm', fetchImpl: fakeFetch, rawParsing: true });
    // Native tool_calls unset + rawParsing → the raw model "made no call" (~0%).
    expect(await backend.callModel('q', [fn])).toEqual([]);
  });
});

describe('parseTextCalls (SideCar real-parser recovery)', () => {
  const weather: BfclFunctionSchema = {
    name: 'get_weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  };

  it('recovers a fenced JSON call', () => {
    expect(parseTextCalls('```json\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```', [weather])).toEqual([
      { name: 'get_weather', args: { city: 'Paris' } },
    ]);
  });
  it('recovers a bare JSON call', () => {
    expect(parseTextCalls('{"name":"get_weather","arguments":{"city":"Rome"}}', [weather])).toEqual([
      { name: 'get_weather', args: { city: 'Rome' } },
    ]);
  });
  it('returns empty for prose with no call', () => {
    expect(parseTextCalls('The weather is nice today.', [weather])).toEqual([]);
  });
});
