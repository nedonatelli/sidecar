import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OllamaBackend,
  probeModelToolSupport,
  modelSupportsTools,
  recordToolFailure,
  recordToolSuccess,
} from './ollamaBackend.js';
import type { ChatMessage, ToolDefinition, StreamEvent } from './types.js';

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

    it('emits a usage event with Ollama token counts on the done chunk', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: 'ok' }, done: false },
          {
            model: 'test',
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 1234,
            eval_count: 56,
          },
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      const usage = events.find((e) => e.type === 'usage');
      expect(usage, 'ollama done chunk should surface prompt_eval_count/eval_count').toBeDefined();
      if (usage?.type === 'usage') {
        expect(usage.usage.inputTokens).toBe(1234);
        expect(usage.usage.outputTokens).toBe(56);
      }
      // Usage must precede stop so the loop records real input tokens for this turn.
      expect(events.findIndex((e) => e.type === 'usage')).toBeLessThan(events.findIndex((e) => e.type === 'stop'));
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

    it('keeps the model warm with a BOUNDED keep_alive — never a permanent pin', async () => {
      // keep_alive: -1 pinned every model a session touched forever
      // (expires_at year 2318); switching models accumulated pinned GBs
      // until the host machine choked. Each request refreshes the TTL, so
      // a bounded value costs nothing during active use.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([{ message: { content: 'hi' }, done: true }]),
      });
      for await (const _ of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        /* drain */
      }
      const body = JSON.parse(mockFetch.mock.calls.at(-1)![1].body);
      expect(body.keep_alive).toBe('30m');
      expect(body.keep_alive).not.toBe(-1);
    });

    it('caps num_ctx per model: llama3.2 gets 64K even when it advertises 131K', async () => {
      // llama3.2 attends globally on every layer — at the 131K default a
      // "2GB" model allocated a 17.4GB llama-server (observed live). Seed the
      // probe cache with the advertised 131K, then verify the per-model cap
      // clamps the request to 64K (and gemma keeps the full window).
      const probeShow = (_model: string) =>
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ capabilities: ['tools'], model_info: { 'llama.context_length': 131_072 } }),
        });
      const respond = () =>
        mockFetch.mockResolvedValueOnce({
          ok: true,
          body: ndjsonBody([{ message: { content: 'hi' }, done: true }]),
        });

      probeShow('llama3.2:latest');
      await probeModelToolSupport('http://localhost:11434', 'llama3.2:latest');
      respond();
      for await (const _ of backend.streamChat('llama3.2:latest', '', [{ role: 'user', content: 'hi' }])) {
        /* drain */
      }
      expect(JSON.parse(mockFetch.mock.calls.at(-1)![1].body).options.num_ctx).toBe(65_536);

      probeShow('gemma4:e4b');
      await probeModelToolSupport('http://localhost:11434', 'gemma4:e4b');
      respond();
      for await (const _ of backend.streamChat('gemma4:e4b', '', [{ role: 'user', content: 'hi' }])) {
        /* drain */
      }
      expect(JSON.parse(mockFetch.mock.calls.at(-1)![1].body).options.num_ctx).toBe(131_072);
    });

    it('sets options.seed from SIDECAR_AGENT_SEED for reproducible runs, absent otherwise', async () => {
      const respond = () =>
        mockFetch.mockResolvedValueOnce({
          ok: true,
          body: ndjsonBody([
            { model: 'test', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' },
          ]),
        });

      // Unseeded by default — no seed key in options.
      respond();
      for await (const _ of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) void _;
      expect('seed' in JSON.parse(mockFetch.mock.calls.at(-1)![1].body).options).toBe(false);

      // With the env override, the seed is threaded into options.
      process.env.SIDECAR_AGENT_SEED = '1234';
      try {
        respond();
        for await (const _ of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) void _;
        expect(JSON.parse(mockFetch.mock.calls.at(-1)![1].body).options.seed).toBe(1234);
      } finally {
        delete process.env.SIDECAR_AGENT_SEED;
      }
    });

    it('neutralizes presence/frequency penalties so aggressive Modelfile defaults cannot break tool-call XML', async () => {
      // qwen3.5's Modelfile ships presence_penalty 1.5, which pushes the model
      // off the repeated-token tool-call XML format → malformed XML → Ollama 500.
      // We must always send 0 to override it. Regression guard for that fix.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' },
        ]),
      });
      for await (const _ of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) void _;
      const options = JSON.parse(mockFetch.mock.calls.at(-1)![1].body).options;
      expect(options.presence_penalty).toBe(0);
      expect(options.frequency_penalty).toBe(0);
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
  });

  describe('complete — structured output (V3)', () => {
    function mockCompleteResponse(content: string) {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content } }) });
    }

    it('sets body.format to a JSON schema when responseFormat is given', async () => {
      mockCompleteResponse('{"findings":[]}');
      const schema = { type: 'object', properties: { findings: { type: 'array' } } };
      await backend.complete('m', 'sys', [{ role: 'user', content: 'hi' }], 1024, undefined, schema);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.format).toEqual(schema);
    });

    it("sets body.format to 'json' for the json sentinel", async () => {
      mockCompleteResponse('{}');
      await backend.complete('m', 'sys', [{ role: 'user', content: 'hi' }], 1024, undefined, 'json');
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).format).toBe('json');
    });

    it('omits format entirely when no responseFormat is given (unchanged behavior)', async () => {
      mockCompleteResponse('plain text');
      await backend.complete('m', 'sys', [{ role: 'user', content: 'hi' }], 1024);
      expect('format' in JSON.parse(mockFetch.mock.calls[0][1].body)).toBe(false);
    });

    it('emits warning and does not send tools for unsupported models', async () => {
      // First call: probe returns no tool support
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ capabilities: ['completion'] }),
      });

      // Probe the model so the cache knows it lacks tools
      await probeModelToolSupport('http://localhost:11434', 'notool-model');

      // Second call: the actual chat request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          {
            model: 'notool-model',
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
        'notool-model',
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

      // Check that tools were not sent to the API (second fetch call is the chat)
      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
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

    it('yields a warning text event when Ollama 500s with tool-not-found', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Headers(),
        text: async () => '{"error":"tool \'run_command\' not found"}',
      });

      const events: StreamEvent[] = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text');
      expect((events[0] as { type: 'text'; text: string }).text).toContain("'run_command'");
      expect((events[0] as { type: 'text'; text: string }).text).toContain('not available');
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

    it('emits thinking events from native message.thinking field (GLM-style)', async () => {
      // GLM-4 and similar models put their chain-of-thought in message.thinking
      // with message.content="" during reasoning, then switch to message.content
      // for the final answer. Our parser must emit thinking events so the
      // per-event stall timer stays alive while the model reasons.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: ndjsonBody([
          { model: 'test', message: { role: 'assistant', content: '', thinking: 'The user' }, done: false },
          { model: 'test', message: { role: 'assistant', content: '', thinking: ' wants a greeting' }, done: false },
          { model: 'test', message: { role: 'assistant', content: 'Hello!', thinking: '' }, done: false },
          { model: 'test', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ]),
      });

      const events = [];
      for await (const event of backend.streamChat('test', '', [{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: 'thinking', thinking: 'The user' });
      expect(events).toContainEqual({ type: 'thinking', thinking: ' wants a greeting' });
      expect(events).toContainEqual({ type: 'text', text: 'Hello!' });
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

describe('probeModelToolSupport', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns true when capabilities include tools', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ capabilities: ['completion', 'tools'] }),
    });

    const result = await probeModelToolSupport('http://localhost:11434', 'probe-test-tools');
    expect(result).toBe(true);
  });

  it('returns false when capabilities lack tools', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ capabilities: ['completion'] }),
    });

    const result = await probeModelToolSupport('http://localhost:11434', 'probe-test-notools');
    expect(result).toBe(false);
  });

  it('returns true on network error (optimistic)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));

    const result = await probeModelToolSupport('http://localhost:11434', 'probe-test-error');
    expect(result).toBe(true);
  });

  it('returns true when model not found (not installed)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await probeModelToolSupport('http://localhost:11434', 'probe-test-404');
    expect(result).toBe(true);
  });

  it('caches results so subsequent calls skip fetch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ capabilities: ['completion', 'tools'] }),
    });

    await probeModelToolSupport('http://localhost:11434', 'probe-test-cache');
    await probeModelToolSupport('http://localhost:11434', 'probe-test-cache');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('modelSupportsTools reflects probed result', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ capabilities: ['completion'] }),
    });

    await probeModelToolSupport('http://localhost:11434', 'probe-test-sync');
    expect(modelSupportsTools('probe-test-sync')).toBe(false);
  });
});

describe('runtime tool failure tracking', () => {
  it('disables tools after threshold failures', () => {
    const model = 'failure-test-model';
    expect(modelSupportsTools(model)).toBe(true);
    recordToolFailure(model);
    recordToolFailure(model);
    expect(modelSupportsTools(model)).toBe(true);
    recordToolFailure(model);
    expect(modelSupportsTools(model)).toBe(false);
  });

  it('resets on success', () => {
    const model = 'success-test-model';
    recordToolFailure(model);
    recordToolFailure(model);
    recordToolSuccess(model);
    expect(modelSupportsTools(model)).toBe(true);
  });
});

describe('thinking mode', () => {
  /** Run one streamChat and return the `options` object we sent to Ollama. */
  async function capturedOptions(model: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const settings = await import('../config/settings.js');
    vi.spyOn(settings, 'getConfig').mockReturnValue({
      agentTemperature: 0,
      agentSeed: null,
      ollamaNumCtx: 0,
      ollamaDisableThinking: false,
      ...config,
    } as never);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: ndjsonBody([{ model, message: { role: 'assistant', content: 'x' }, done: true, done_reason: 'stop' }]),
    });
    const b = new OllamaBackend('http://localhost:11434');
    for await (const _ of b.streamChat(model, '', [{ role: 'user', content: 'hi' }])) {
      // drain
    }
    const body = JSON.parse(mockFetch.mock.calls.at(-1)![1].body as string);
    return body.options as Record<string, unknown>;
  }

  it('leaves thinking ON by default for models that support it', async () => {
    const options = await capturedOptions('qwen3.5:latest', { ollamaDisableThinking: false });
    expect(options.think).toBeUndefined(); // unset → Ollama uses the model default
  });

  it('disables thinking when the user opts out', async () => {
    const options = await capturedOptions('qwen3.5:latest', { ollamaDisableThinking: true });
    expect(options.think).toBe(false);
  });

  it('disables thinking for known-problematic models even without an opt-out', async () => {
    // These stall / stop emitting tool calls with thinking on. The list was
    // honored ONLY by the eval harness — production shipped the failure mode.
    for (const model of ['qwen3:8b', 'qwen3:14b', 'qwen3:32b', 'glm-4.7-flash:latest']) {
      const options = await capturedOptions(model, { ollamaDisableThinking: false });
      expect({ model, think: options.think }).toEqual({ model, think: false });
    }
  });
});
