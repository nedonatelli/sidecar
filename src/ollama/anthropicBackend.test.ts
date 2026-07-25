import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AnthropicBackend,
  buildSystemBlocks,
  prepareMessagesForCache,
  repairDanglingToolUses,
} from './anthropicBackend.js';

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

describe('prepareMessagesForCache', () => {
  it('returns messages unchanged when fewer than 3', () => {
    const msgs = [{ role: 'user' as const, content: 'hi' }];
    expect(prepareMessagesForCache(msgs)).toBe(msgs);
  });

  it('returns messages unchanged when no assistant message exists', () => {
    const msgs = [
      { role: 'user' as const, content: 'a' },
      { role: 'user' as const, content: 'b' },
      { role: 'user' as const, content: 'c' },
    ];
    expect(prepareMessagesForCache(msgs)).toEqual(msgs);
  });

  it('marks the last assistant message with cache_control', () => {
    const msgs = [
      { role: 'user' as const, content: 'task' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'thinking' }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'x', content: 'result' }] },
    ];
    const result = prepareMessagesForCache(msgs);
    // Assistant message (index 1) should be marked; user messages untouched
    const assistantContent = result[1].content as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(assistantContent)).toBe(true);
    expect(assistantContent[assistantContent.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // Last user message must not be touched
    expect(JSON.stringify(result[2].content)).not.toContain('cache_control');
  });

  it('marks the last (not second-to-last) assistant in a longer history', () => {
    const msgs = [
      { role: 'user' as const, content: 'task' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'first' }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'a', content: 'r1' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'second' }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'b', content: 'r2' }] },
    ];
    const result = prepareMessagesForCache(msgs);
    // Only the last assistant (index 3) should be marked
    const first = result[1].content as Array<{ cache_control?: unknown }>;
    const last = result[3].content as Array<{ cache_control?: unknown }>;
    expect(first[first.length - 1].cache_control).toBeUndefined();
    expect(last[last.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('normalises a string-content assistant message to a text block', () => {
    const msgs = [
      { role: 'user' as const, content: 'task' },
      { role: 'assistant' as const, content: 'plain text response' },
      { role: 'user' as const, content: 'follow-up' },
    ];
    const result = prepareMessagesForCache(msgs);
    expect(Array.isArray(result[1].content)).toBe(true);
    const blocks = result[1].content as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(blocks[0].text).toBe('plain text response');
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does not mutate the original messages array', () => {
    const msgs = [
      { role: 'user' as const, content: 'task' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] },
      { role: 'user' as const, content: 'follow' },
    ];
    const original = JSON.stringify(msgs);
    prepareMessagesForCache(msgs);
    expect(JSON.stringify(msgs)).toBe(original);
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

    it('emits usage event with cache_creation_input_tokens > 0 on multi-turn conversation', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 800,
                output_tokens: 0,
                cache_creation_input_tokens: 420,
                cache_read_input_tokens: 0,
              },
            },
          }),
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } }),
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
          sse({ type: 'message_stop' }),
        ]),
      });

      const multiTurnMessages = [
        { role: 'user' as const, content: 'fix my code' },
        { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'reading files' }] },
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: 'x', content: 'file content here' }],
        },
      ];

      const events = [];
      for await (const event of backend.streamChat('claude-3-5-sonnet-20241022', 'sys', multiTurnMessages)) {
        events.push(event);
      }

      const usageEvent = events.find((e) => e.type === 'usage');
      expect(usageEvent).toBeDefined();
      if (usageEvent?.type === 'usage') {
        expect(usageEvent.usage.cacheCreationInputTokens).toBeGreaterThan(0);
      }

      // Verify the request body marked the last assistant message for caching
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const assistantMsg = body.messages.find((m: { role: string }) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      const lastBlock = assistantMsg.content[assistantMsg.content.length - 1];
      expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    });

    // mid-stream network death on the Anthropic SSE path.
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

  // ---------------------------------------------------------------------------
  // message_delta output_tokens: SET semantics, not accumulate
  //
  // Anthropic's protocol sends cumulative output_tokens on message_delta events.
  // The backend must SET accOutputTokens = event.usage.output_tokens on each
  // event, NOT add to it. If it accumulated, a stream with two message_delta
  // events reporting [10, 20] would emit outputTokens=30 instead of the correct
  // outputTokens=20.
  // ---------------------------------------------------------------------------
  describe('message_delta output_tokens SET semantics', () => {
    it('uses the final message_delta output_tokens value (not the sum)', async () => {
      // Simulate two message_delta events: first reports 10, second reports 20 (cumulative).
      // Correct behaviour: outputTokens = 20.
      // Incorrect (accumulate) behaviour: outputTokens = 30.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } }),
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'part one ' } }),
          // First message_delta: cumulative output so far = 10
          sse({ type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 10 } }),
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'part two' } }),
          // Second message_delta (final): cumulative output total = 20
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }),
          sse({ type: 'message_stop' }),
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3-5-sonnet-20241022', 'sys', [
        { role: 'user', content: 'hi' },
      ])) {
        events.push(event);
      }

      const usageEvent = events.find((e) => e.type === 'usage');
      expect(usageEvent).toBeDefined();
      if (usageEvent?.type === 'usage') {
        // Must be 20 (the last value SET), not 30 (accumulated sum of 10+20)
        expect(usageEvent.usage.outputTokens).toBe(20);
        expect(usageEvent.usage.inputTokens).toBe(100);
      }
    });

    it('reports zero output tokens when message_delta carries no usage field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([
          sse({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } }),
          sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
          // message_delta with no usage field (shouldn't change the counter)
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
          sse({ type: 'message_stop' }),
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('claude-3-5-sonnet-20241022', 'sys', [
        { role: 'user', content: 'hi' },
      ])) {
        events.push(event);
      }

      const usageEvent = events.find((e) => e.type === 'usage');
      expect(usageEvent).toBeDefined();
      if (usageEvent?.type === 'usage') {
        expect(usageEvent.usage.outputTokens).toBe(0);
      }
    });
  });
});

describe('repairDanglingToolUses (strict pairing safety net)', () => {
  it('inserts a synthetic tool_result after a dangling tool_use', () => {
    const messages = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fence_write_1', name: 'write_file', input: {} }] },
      { role: 'user', content: 'next real request' },
    ] as never;
    const out = repairDanglingToolUses(messages);
    expect(out).toHaveLength(4);
    expect(out[2].role).toBe('user');
    const blocks = out[2].content as Array<{ type: string; tool_use_id?: string; content?: string }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('fence_write_1');
    expect(blocks[0].content).toContain('interrupted');
    expect(out[3].content).toBe('next real request');
  });

  it('merges the synthetic result into an adjacent partial tool_result carrier', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'read_file', input: {} },
          { type: 'tool_use', id: 'b', name: 'read_file', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ] as never;
    const out = repairDanglingToolUses(messages);
    expect(out).toHaveLength(2);
    const blocks = out[1].content as Array<{ tool_use_id?: string }>;
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['b', 'a']);
  });

  it('returns the input untouched when every pair is intact', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    ] as never;
    expect(repairDanglingToolUses(messages)).toBe(messages);
  });
});

describe('repairDanglingToolUses — orphaned-result pass (the mirror 400)', () => {
  it('downgrades a tool_result with no matching tool_use to a text block', () => {
    const messages = [
      { role: 'user', content: 'earlier context' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'fence_write_1', content: 'File written: config.ts' },
          { type: 'text', text: 'next request' },
        ],
      },
    ] as never;
    const out = repairDanglingToolUses(messages);
    const blocks = out[1].content as Array<{ type: string; text?: string }>;
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('File written: config.ts');
    expect(blocks.some((b) => b.type === 'tool_result')).toBe(false);
  });

  it('keeps results whose tool_use exists; downgrades only the orphan', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'good', name: 't', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'good', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'orphan', content: 'lost pair' },
        ],
      },
    ] as never;
    const out = repairDanglingToolUses(messages);
    const blocks = out[1].content as Array<{ type: string; tool_use_id?: string; text?: string }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].text).toContain('lost pair');
  });

  it('is idempotent — a repaired history passes through unchanged', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ] as never;
    const once = repairDanglingToolUses(messages);
    expect(repairDanglingToolUses(once)).toBe(once);
  });
});
