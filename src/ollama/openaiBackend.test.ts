import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIBackend } from './openaiBackend.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function sseBody(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const data = events.map((e) => `data: ${e}\n\n`).join('');
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        controller.enqueue(encoder.encode(data));
        sent = true;
      } else {
        controller.close();
      }
    },
  });
}

function chunk(content: string, done = false): string {
  return JSON.stringify({
    choices: [
      {
        delta: { content, role: 'assistant' },
        finish_reason: done ? 'stop' : null,
      },
    ],
  });
}

describe('OpenAIBackend', () => {
  let backend: OpenAIBackend;

  beforeEach(() => {
    backend = new OpenAIBackend('http://localhost:1234', 'test-key');
    mockFetch.mockReset();
  });

  describe('streamChat', () => {
    it('yields text events from SSE stream', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('Hello'), chunk(' world'), chunk('', true), '[DONE]']),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'Hello' });
      expect(events).toContainEqual({ type: 'text', text: ' world' });
    });

    it('handles malformed JSON in SSE events gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody(['not valid json', chunk('ok'), '[DONE]']),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'ok' });
    });

    it('handles partial SSE chunks that split across reads', async () => {
      const encoder = new TextEncoder();
      const line1 = `data: ${chunk('hello')}\n\n`;
      const line2 = `data: [DONE]\n\n`;
      const mid = Math.floor(line1.length / 2);

      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(line1.slice(0, mid)));
          controller.enqueue(encoder.encode(line1.slice(mid) + line2));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'hello' });
    });

    it('parses <think> tags across multiple chunks', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('<think>reasoning'), chunk(' more</think>answer'), '[DONE]']),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'think' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'thinking', thinking: 'reasoning' });
      expect(events).toContainEqual({ type: 'thinking', thinking: ' more' });
      expect(events).toContainEqual({ type: 'text', text: 'answer' });
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers(),
        text: async () => 'Invalid API key',
      });

      await expect(async () => {
        for await (const _event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
          // consume
        }
      }).rejects.toThrow('OpenAI API request failed: 401');
    });

    it('handles empty response body', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: null });

      await expect(async () => {
        for await (const _event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
          // consume
        }
      }).rejects.toThrow('empty response body');
    });

    it('accumulates incremental tool call arguments', async () => {
      const toolCallChunk = (index: number, id?: string, name?: string, args?: string) =>
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    ...(id ? { id } : {}),
                    ...(name || args
                      ? { function: { ...(name ? { name } : {}), ...(args ? { arguments: args } : {}) } }
                      : {}),
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          toolCallChunk(0, 'tc_1', 'read_file', ''),
          toolCallChunk(0, undefined, undefined, '{"path"'),
          toolCallChunk(0, undefined, undefined, ':"index.ts"}'),
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          }),
          '[DONE]',
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'read' }])) {
        events.push(event);
      }

      const toolEvent = events.find((e) => e.type === 'tool_use');
      expect(toolEvent).toBeDefined();
      if (toolEvent?.type === 'tool_use') {
        expect(toolEvent.toolUse.name).toBe('read_file');
        expect(toolEvent.toolUse.input).toEqual({ path: 'index.ts' });
      }
    });

    it('handles tool calls with malformed JSON arguments', async () => {
      const toolCallChunk = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'read_file', arguments: '{bad json' } }],
            },
            finish_reason: null,
          },
        ],
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          toolCallChunk,
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          '[DONE]',
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'read' }])) {
        events.push(event);
      }

      // Should still emit the tool_use with empty input rather than crashing
      const toolEvent = events.find((e) => e.type === 'tool_use');
      expect(toolEvent).toBeDefined();
      if (toolEvent?.type === 'tool_use') {
        expect(toolEvent.toolUse.name).toBe('read_file');
        expect(toolEvent.toolUse.input).toEqual({});
      }
    });

    it('flushes pending tool calls on [DONE] when no finish_reason', async () => {
      const toolCallChunk = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
            },
            finish_reason: null,
          },
        ],
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([toolCallChunk, '[DONE]']),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'read' }])) {
        events.push(event);
      }

      const toolEvent = events.find((e) => e.type === 'tool_use');
      expect(toolEvent).toBeDefined();
      if (toolEvent?.type === 'tool_use') {
        expect(toolEvent.toolUse.name).toBe('read_file');
        expect(toolEvent.toolUse.input).toEqual({ path: 'a.ts' });
      }
    });

    it('handles finish_reason "length" as max_tokens stop', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          chunk('truncated'),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
          '[DONE]',
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'truncated' });
      expect(events).toContainEqual({ type: 'stop', stopReason: 'max_tokens' });
    });

    it('handles stream ending abruptly without [DONE]', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('partial')]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'partial' });
      // Should not crash, just end without a stop event
      expect(events.find((e) => e.type === 'stop')).toBeUndefined();
    });

    it('handles SSE lines without data prefix', async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(': comment line\n'));
          controller.enqueue(encoder.encode('event: ping\n'));
          controller.enqueue(encoder.encode(`data: ${chunk('hello')}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'hello' });
    });

    it('handles chunks with no choices array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          JSON.stringify({ choices: [] }), // empty choices
          JSON.stringify({}), // no choices at all
          chunk('ok'),
          '[DONE]',
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'ok' });
    });
  });

  describe('complete', () => {
    it('returns text from non-streaming response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'The answer is 42.' } }],
        }),
      });

      const result = await backend.complete('test', '', [{ role: 'user', content: 'what?' }], 256);
      expect(result).toBe('The answer is 42.');
    });

    it('returns empty string when no choices', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [] }),
      });

      const result = await backend.complete('test', '', [{ role: 'user', content: 'hi' }], 256);
      expect(result).toBe('');
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers(),
        text: async () => 'Rate limited',
      });

      await expect(backend.complete('test', '', [{ role: 'user', content: 'hi' }], 256)).rejects.toThrow(
        'OpenAI API request failed: 429',
      );
    });
  });

  describe('streamChat request body', () => {
    it('includes max_tokens so OpenAI does not reserve the model default against TPM', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('ok', true), '[DONE]']),
      });

      for await (const _e of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        // consume
      }

      const call = mockFetch.mock.calls[0];
      const sentBody = JSON.parse(call[1].body);
      expect(sentBody.max_tokens).toBe(4096);
    });

    it('sets stream_options.include_usage so the final chunk carries usage totals', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('ok', true), '[DONE]']),
      });

      for await (const _e of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        // consume
      }

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(sentBody.stream_options).toEqual({ include_usage: true });
    });

    it('emits a usage event when OpenAI reports one on the final chunk', async () => {
      const usageChunk = JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('hi', true), usageChunk, '[DONE]']),
      });

      const events = [];
      for await (const event of backend.streamChat('gpt-4o', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      const usageEvent = events.find((e) => e.type === 'usage');
      expect(usageEvent).toBeDefined();
      if (usageEvent?.type === 'usage') {
        expect(usageEvent.usage.inputTokens).toBe(1234);
        expect(usageEvent.usage.outputTokens).toBe(56);
        expect(usageEvent.model).toBe('gpt-4o');
      }
    });
  });
});
