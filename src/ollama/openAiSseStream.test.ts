/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { streamOpenAiSse } from './openAiSseStream';
import type { StreamEvent } from './types.js';

/**
 * Build a mock Response whose body yields the given SSE frames exactly
 * as OpenAI would send them — one `data: ...\n` line per frame plus a
 * closing `data: [DONE]\n` sentinel. The test helper collects everything
 * into a single ReadableStream so `response.body.getReader()` works the
 * same way as in production.
 */
function mockSseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('streamOpenAiSse', () => {
  it('yields text events for content deltas', async () => {
    const response = mockSseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);
    const events = await collect(streamOpenAiSse(response, 'gpt-4o', undefined, undefined));
    const texts = events.filter((e) => e.type === 'text').map((e: any) => e.text);
    expect(texts.join('')).toBe('Hello world');
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' });
  });

  it('emits a usage event when the final chunk carries usage info', async () => {
    const response = mockSseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } }),
    ]);
    const events = await collect(streamOpenAiSse(response, 'gpt-4o', undefined, undefined));
    const usage = events.find((e) => e.type === 'usage') as any;
    expect(usage).toBeDefined();
    expect(usage.model).toBe('gpt-4o');
    expect(usage.usage.inputTokens).toBe(42);
    expect(usage.usage.outputTokens).toBe(7);
  });

  it('reconstructs incremental tool_calls into a single tool_use event', async () => {
    const response = mockSseResponse([
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'read_file' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/a.ts"}' } }] },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    const events = await collect(streamOpenAiSse(response, 'gpt-4o', undefined, undefined));
    const toolUses = events.filter((e) => e.type === 'tool_use') as any[];
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].toolUse.id).toBe('call_abc');
    expect(toolUses[0].toolUse.name).toBe('read_file');
    expect(toolUses[0].toolUse.input).toEqual({ path: '/tmp/a.ts' });
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'tool_use' });
  });

  it('synthesizes an id when the upstream server omits one', async () => {
    const response = mockSseResponse([
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: 'ping', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ]);
    const events = await collect(
      streamOpenAiSse(response, 'gpt-4o', undefined, undefined, { toolCallIdPrefix: 'myprov' }),
    );
    const toolUse = events.find((e) => e.type === 'tool_use') as any;
    expect(toolUse.toolUse.id).toMatch(/^myprov_tc_\d+$/);
  });

  it('maps finish_reason=length to stop_reason=max_tokens', async () => {
    const response = mockSseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'cut' }, finish_reason: 'length' }] }),
    ]);
    const events = await collect(streamOpenAiSse(response, 'gpt-4o', undefined, undefined));
    expect(events.at(-1)).toEqual({ type: 'stop', stopReason: 'max_tokens' });
  });

  it('skips malformed JSON frames without aborting the stream', async () => {
    const response = mockSseResponse([
      'not-valid-json-{]',
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'recovered' }, finish_reason: 'stop' }] }),
    ]);
    const events = await collect(streamOpenAiSse(response, 'gpt-4o', undefined, undefined));
    const texts = events.filter((e) => e.type === 'text').map((e: any) => e.text);
    expect(texts.join('')).toBe('recovered');
  });

  it('throws when the response body is empty', async () => {
    const emptyResponse = new Response(null, { status: 200 });
    await expect(async () => {
      for await (const _ of streamOpenAiSse(emptyResponse, 'gpt-4o', undefined, undefined)) {
        /* drain */
      }
    }).rejects.toThrow('empty response body');
  });
});
