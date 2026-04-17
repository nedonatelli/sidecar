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

  // v0.62.3 — mid-stream connection death. The existing suite covers
  // initial-fetch failures via retry.test.ts, but not a stream that
  // starts fine, yields some frames, then the TCP connection dies
  // before `data: [DONE]`. Ollama process crashes, laptop drops from
  // WiFi, provider LB kills long-lived connections — all hit this
  // codepath. The generator must propagate the error; swallowing it
  // would leave the agent loop waiting forever.
  describe('mid-stream connection death', () => {
    it('propagates the error when the body stream errors after some frames', async () => {
      // The enqueue + error sequencing inside `start()` may or may not
      // deliver the enqueued chunk depending on the platform's internal
      // buffering semantics; what matters for the agent loop is that
      // the error surfaces so the caller can give up. Deliver one frame
      // on the first read and error on the second so the order is
      // deterministic.
      const encoder = new TextEncoder();
      let readCount = 0;
      const firstChunk = encoder.encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}\n\n`,
      );
      const response = {
        body: {
          getReader: () => ({
            read: async () => {
              readCount += 1;
              if (readCount === 1) return { done: false, value: firstChunk };
              // Simulate the kernel dropping the socket — the reader's
              // promise rejects with the underlying network error.
              throw new Error('ECONNRESET: connection reset by peer');
            },
            releaseLock: () => {},
          }),
        },
      } as unknown as Response;

      const received: StreamEvent[] = [];
      let thrown: unknown = null;
      try {
        for await (const ev of streamOpenAiSse(response, 'gpt-4o', undefined, undefined)) {
          received.push(ev);
        }
      } catch (err) {
        thrown = err;
      }

      // The 'partial' text yielded before the drop survives.
      const texts = received.filter((e) => e.type === 'text').map((e: any) => e.text);
      expect(texts.join('')).toBe('partial');
      // And the generator ends by throwing so the caller knows the
      // stream failed rather than hanging forever.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('ECONNRESET');
    });

    it('propagates an abrupt close mid-frame (no trailing [DONE])', async () => {
      // Same failure family as ECONNRESET but seen as a clean stream
      // close instead of an error — the upstream LB sometimes half-
      // closes the response without a terminating DONE sentinel. The
      // stream SHOULD end gracefully (no error), and the consumer sees
      // only the frames that made it through. We're pinning that this
      // DOESN'T hang and DOESN'T re-throw.
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'before drop' }, finish_reason: null }] })}\n\n`,
            ),
          );
          // Close without [DONE] — connection closed normally but
          // early.
          controller.close();
        },
      });
      const response = new Response(body, { status: 200 });

      const events: StreamEvent[] = [];
      for await (const ev of streamOpenAiSse(response, 'gpt-4o', undefined, undefined)) {
        events.push(ev);
      }
      const texts = events.filter((e) => e.type === 'text').map((e: any) => e.text);
      expect(texts.join('')).toBe('before drop');
    });

    it('propagates an error thrown by the reader after the first chunk', async () => {
      // Different shape from controller.error(): some environments
      // (Node's undici in particular) surface a mid-stream network
      // drop as a rejection from the NEXT reader.read() rather than
      // flowing through controller.error(). Cover both.
      const encoder = new TextEncoder();
      let readCount = 0;
      const firstChunk = encoder.encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'chunk' }, finish_reason: null }] })}\n\n`,
      );
      const response = {
        body: {
          getReader: () => ({
            read: async () => {
              readCount += 1;
              if (readCount === 1) return { done: false, value: firstChunk };
              throw new Error('socket hang up');
            },
            releaseLock: () => {},
          }),
        },
      } as unknown as Response;

      let thrown: unknown = null;
      try {
        for await (const _ of streamOpenAiSse(response, 'gpt-4o', undefined, undefined)) {
          void _;
        }
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('socket hang up');
    });
  });
});
