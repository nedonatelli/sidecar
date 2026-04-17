import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicBackend, buildSystemBlocks } from './anthropicBackend.js';

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

/** Helper to build an Anthropic SSE event string. */
function sse(event: object): string {
  return JSON.stringify(event);
}

describe('buildSystemBlocks', () => {
  it('caches entire prompt when no workspace context present', () => {
    const prompt = 'You are SideCar, an AI coding assistant.';
    const blocks = buildSystemBlocks(prompt);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(prompt);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('splits into cached prefix and uncached workspace context', () => {
    const prefix = 'You are SideCar.\n\nProject instructions from SIDECAR.md:\nUse TypeScript.\n\n';
    const context =
      '## Workspace Structure\n```\nsrc/index.ts\n```\n\n## Relevant Files\n### src/index.ts\n```\nconst x = 1;\n```';
    const prompt = prefix + context;

    const blocks = buildSystemBlocks(prompt);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe(prefix.trimEnd());
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].text).toBe(context);
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it('caches full prompt when workspace marker is at position 0', () => {
    const prompt = '## Workspace Structure\nsome content';
    const blocks = buildSystemBlocks(prompt);
    // Marker at position 0 means no stable prefix to cache separately
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles empty prompt', () => {
    const blocks = buildSystemBlocks('');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('');
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('AnthropicBackend', () => {
  let backend: AnthropicBackend;

  beforeEach(() => {
    backend = new AnthropicBackend('https://api.anthropic.com', 'test-key');
    mockFetch.mockReset();
  });

  describe('streamChat', () => {
    it('yields text events from SSE stream', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }),
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }),
          sse({ type: 'content_block_stop' }),
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'Hello' });
      expect(events).toContainEqual({ type: 'text', text: ' world' });
      expect(events).toContainEqual({ type: 'stop', stopReason: 'end_turn' });
    });

    it('yields tool_use events from tool call stream', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' },
          }),
          sse({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
          sse({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '"index.ts"}' } }),
          sse({ type: 'content_block_stop' }),
          sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'read file' }])) {
        events.push(event);
      }

      const toolEvent = events.find((e) => e.type === 'tool_use');
      expect(toolEvent).toBeDefined();
      if (toolEvent?.type === 'tool_use') {
        expect(toolEvent.toolUse.name).toBe('read_file');
        expect(toolEvent.toolUse.id).toBe('tu_1');
        expect(toolEvent.toolUse.input).toEqual({ path: 'index.ts' });
      }
      expect(events).toContainEqual({ type: 'stop', stopReason: 'tool_use' });
    });

    it('yields thinking events from thinking blocks', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({ type: 'content_block_start', content_block: { type: 'thinking' } }),
          sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me think...' } }),
          sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: ' about this.' } }),
          sse({ type: 'content_block_stop' }),
          sse({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer here.' } }),
          sse({ type: 'content_block_stop' }),
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'think' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'thinking', thinking: 'Let me think...' });
      expect(events).toContainEqual({ type: 'thinking', thinking: ' about this.' });
      expect(events).toContainEqual({ type: 'text', text: 'Answer here.' });
    });

    it('handles malformed JSON in SSE events gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          'not valid json',
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }),
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'ok' });
    });

    it('handles partial SSE chunks that split across reads', async () => {
      const encoder = new TextEncoder();
      const event1 = `data: ${sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } })}\n\n`;
      const event2 = `data: ${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`;
      const mid = Math.floor(event1.length / 2);

      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(event1.slice(0, mid)));
          controller.enqueue(encoder.encode(event1.slice(mid) + event2));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body });

      const events = [];
      for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'hello' });
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
        for await (const _event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
          // consume
        }
      }).rejects.toThrow('Anthropic API request failed: 401');
    });

    it('throws on empty response body', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: null });

      await expect(async () => {
        for await (const _event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
          // consume
        }
      }).rejects.toThrow('empty response body');
    });

    it('throws on mid-stream error event', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }),
          sse({ type: 'error', error: { type: 'overloaded_error', message: 'API is overloaded' } }),
        ]),
      });

      await expect(async () => {
        for await (const _event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
          // consume
        }
      }).rejects.toThrow('API is overloaded');
    });

    it('handles tool_use with malformed JSON input gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tu_2', name: 'read_file' },
          }),
          sse({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{invalid json' } }),
          sse({ type: 'content_block_stop' }),
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
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

    it('handles multiple tool calls in sequence', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' },
          }),
          sse({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } }),
          sse({ type: 'content_block_stop' }),
          sse({
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tu_2', name: 'read_file' },
          }),
          sse({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"b.ts"}' } }),
          sse({ type: 'content_block_stop' }),
          sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'read both' }])) {
        events.push(event);
      }

      const toolEvents = events.filter((e) => e.type === 'tool_use');
      expect(toolEvents).toHaveLength(2);
      if (toolEvents[0].type === 'tool_use' && toolEvents[1].type === 'tool_use') {
        expect(toolEvents[0].toolUse.input).toEqual({ path: 'a.ts' });
        expect(toolEvents[1].toolUse.input).toEqual({ path: 'b.ts' });
      }
    });

    it('ignores content_block_delta with no delta', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({ type: 'content_block_delta' }), // missing delta field
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }),
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'ok' });
    });

    it('sends correct headers and request format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3', 'Be helpful', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options.headers['x-api-key']).toBe('test-key');
      expect(options.headers['anthropic-version']).toBe('2023-06-01');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('claude-3');
      expect(body.stream).toBe(true);
      expect(body.system).toBeDefined();
    });

    it('handles stream ending without stop reason', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial response' } }),
          // stream ends abruptly — no message_delta with stop_reason
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'partial response' });
      // Should not crash, just end without a stop event
      expect(events.find((e) => e.type === 'stop')).toBeUndefined();
    });

    // v0.62.3 — mid-stream network death on the Anthropic SSE path.
    // Parallel to the test in openAiSseStream.test.ts but exercising
    // Anthropic's own parser, which has a different state machine
    // (events-by-type vs. choices[].delta). An error mid-read must
    // propagate so the agent loop can abort or retry rather than
    // hang on a half-open stream.
    it('propagates a mid-stream reader error', async () => {
      const encoder = new TextEncoder();
      const firstChunk = encoder.encode(
        `event: content_block_delta\ndata: ${sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } })}\n\n`,
      );
      let readCount = 0;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              readCount += 1;
              if (readCount === 1) return { done: false, value: firstChunk };
              throw new Error('ECONNRESET: socket closed mid-stream');
            },
            releaseLock: () => {},
          }),
        },
      });

      const events: Array<{ type: string; text?: string }> = [];
      let thrown: unknown = null;
      try {
        for await (const event of backend.streamChat('claude-3', '', [{ role: 'user', content: 'hi' }])) {
          events.push(event as { type: string; text?: string });
        }
      } catch (err) {
        thrown = err;
      }

      // Text delivered before the drop survives in the consumer's buffer.
      expect(events.find((e) => e.type === 'text' && e.text === 'partial')).toBeDefined();
      // And the generator surfaces the network error so the caller
      // can back off / retry rather than hang.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('ECONNRESET');
    });
  });

  describe('complete', () => {
    it('returns text from non-streaming response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'The answer is 42.' }],
          stop_reason: 'end_turn',
        }),
      });

      const result = await backend.complete('claude-3', '', [{ role: 'user', content: 'what?' }], 256);
      expect(result).toBe('The answer is 42.');
    });

    it('returns empty string when no text block in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} }],
          stop_reason: 'tool_use',
        }),
      });

      const result = await backend.complete('claude-3', '', [{ role: 'user', content: 'read' }], 256);
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

      await expect(backend.complete('claude-3', '', [{ role: 'user', content: 'hi' }], 256)).rejects.toThrow(
        'Anthropic API request failed: 429',
      );
    });
  });
});
