import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaBackend } from './ollamaBackend.js';
import type { ChatMessage, ToolDefinition } from './types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ndjsonBody(chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map((c) => JSON.stringify(c) + '\n');
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx < lines.length) {
        controller.enqueue(encoder.encode(lines[idx++]));
      } else {
        controller.close();
      }
    },
  });
}

describe('OllamaBackend', () => {
  let backend: OllamaBackend;

  beforeEach(() => {
    backend = new OllamaBackend('http://localhost:11434');
    mockFetch.mockReset();
  });

  describe('streamChat', () => {
    it('yields text events from NDJSON stream', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: 'Hello' }, done: false },
          { model: 'test', message: { role: 'assistant', content: ' world' }, done: false },
          { model: 'test', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'Hello' });
      expect(events).toContainEqual({ type: 'text', text: ' world' });
      expect(events).toContainEqual({ type: 'stop', stopReason: 'end_turn' });
    });

    it('yields tool_use events from native tool calls', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          {
            model: 'test',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'read_file', arguments: { path: 'index.ts' } } }],
            },
            done: false,
          },
          { model: 'test', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'read index.ts' }])) {
        events.push(event);
      }

      const toolEvent = events.find((e) => e.type === 'tool_use');
      expect(toolEvent).toBeDefined();
      if (toolEvent?.type === 'tool_use') {
        expect(toolEvent.toolUse.name).toBe('read_file');
        expect(toolEvent.toolUse.input).toEqual({ path: 'index.ts' });
        expect(toolEvent.toolUse.id).toMatch(/^ollama_tc_/);
      }
    });

    it('sends system prompt as system message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' },
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', 'Be helpful', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages[0]).toEqual({ role: 'system', content: 'Be helpful' });
    });

    it('converts tools to Ollama format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' },
        ]),
      });

      const tools: ToolDefinition[] = [
        {
          name: 'read_file',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ];

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }], undefined, tools)) {
        events.push(event);
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].type).toBe('function');
      expect(body.tools[0].function.name).toBe('read_file');
    });

    it('emits warning and does not send tools for unsupported models', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          {
            model: 'gemma2:latest',
            message: { role: 'assistant', content: 'response' },
            done: true,
            done_reason: 'stop',
          },
        ]),
      });

      const tools: ToolDefinition[] = [
        {
          name: 'read_file',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ];

      const events = [];
      for await (const event of backend.streamChat(
        'gemma2:latest',
        '',
        [{ role: 'user', content: 'hi' }],
        undefined,
        tools,
      )) {
        events.push(event);
      }

      // Check that warning was emitted
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'warning',
          message: expect.stringContaining('does not support tools'),
        }),
      );

      // Check that tools were not sent to the API
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools).toBeUndefined();
    });

    it('posts to /api/chat endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/chat');
    });

    it('does not send Anthropic headers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['x-api-key']).toBeUndefined();
      expect(headers['anthropic-version']).toBeUndefined();
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers(),
        text: async () => 'model not found',
      });

      await expect(async () => {
        for await (const _event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
          // consume
        }
      }).rejects.toThrow('Ollama request failed: 400');
    });

    it('converts tool_result messages to role:tool', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' },
        ]),
      });

      const messages: ChatMessage[] = [
        { role: 'user', content: 'read a file' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.ts' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'file contents here' }],
        },
      ];

      const events = [];
      for await (const event of backend.streamChat('test', '', messages)) {
        events.push(event);
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg.content).toBe('file contents here');
    });

    it('handles malformed JSON lines gracefully (skips them)', async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('not valid json\n'));
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                model: 'test',
                message: { role: 'assistant', content: 'ok' },
                done: true,
                done_reason: 'stop',
              }) + '\n',
            ),
          );
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'text', text: 'ok' });
      expect(events).toContainEqual({ type: 'stop', stopReason: 'end_turn' });
    });

    it('handles partial chunks that split across reads', async () => {
      const encoder = new TextEncoder();
      const fullLine =
        JSON.stringify({ model: 'test', message: { role: 'assistant', content: 'hello' }, done: false }) + '\n';
      const doneLine =
        JSON.stringify({
          model: 'test',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
        }) + '\n';
      // Split the first line in the middle
      const mid = Math.floor(fullLine.length / 2);

      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(fullLine.slice(0, mid)));
          controller.enqueue(encoder.encode(fullLine.slice(mid)));
          controller.enqueue(encoder.encode(doneLine));
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
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: '<think>reasoning' }, done: false },
          { model: 'test', message: { role: 'assistant', content: ' more</think>answer' }, done: false },
          { model: 'test', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'think' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'thinking', thinking: 'reasoning' });
      expect(events).toContainEqual({ type: 'thinking', thinking: ' more' });
      expect(events).toContainEqual({ type: 'text', text: 'answer' });
    });

    it('handles empty response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: null,
      });

      await expect(async () => {
        for await (const _event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
          // consume
        }
      }).rejects.toThrow('empty response body');
    });

    it('handles stream that ends mid-think tag', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: '<think>reasoning without close' }, done: false },
          { model: 'test', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'think' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'thinking', thinking: 'reasoning without close' });
      // Should emit end-of-reasoning marker
      expect(events).toContainEqual({ type: 'thinking', thinking: '\n(end of reasoning)' });
    });
  });

  describe('complete', () => {
    it('returns text from non-streaming response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'test',
          message: { role: 'assistant', content: 'The answer is 42.' },
          done: true,
        }),
      });

      const result = await backend.complete('test', '', [{ role: 'user', content: 'what?' }], 256);
      expect(result).toBe('The answer is 42.');
    });

    it('uses /api/chat with stream:false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'test',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }),
      });

      await backend.complete('test', '', [{ role: 'user', content: 'hi' }], 256);

      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/chat');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.stream).toBe(false);
    });
  });
});
