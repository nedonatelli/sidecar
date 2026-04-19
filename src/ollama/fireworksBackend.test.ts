import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FireworksBackend } from './fireworksBackend.js';
import { OpenAIBackend } from './openaiBackend.js';

// ---------------------------------------------------------------------------
// FireworksBackend tests (v0.69 chunk 5).
//
// FireworksBackend is an empty subclass of OpenAIBackend — its value is
// provider isolation (circuit breaker, rate-limit store, detectProvider
// routing) and a named type, not new protocol logic. These tests confirm:
//   1. Inheritance: it is an OpenAIBackend at runtime.
//   2. Wire format: it hits the user-supplied base URL, sends Bearer auth,
//      and the full SSE → StreamEvent chain works.
//   3. Tool calls: incremental argument accumulation (inherited) works.
//   4. Error handling: non-OK responses throw the expected error shape.
//   5. complete(): non-streaming path works.
//
// Fireworks model IDs are fully qualified, e.g.
//   accounts/fireworks/models/deepseek-v3
// but that doesn't affect wire protocol — it's just a string parameter.
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1';
const FIREWORKS_KEY = 'fw_test123';
const FIREWORKS_MODEL = 'accounts/fireworks/models/deepseek-v3';

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
    choices: [{ delta: { content, role: 'assistant' }, finish_reason: done ? 'stop' : null }],
  });
}

describe('FireworksBackend', () => {
  let backend: FireworksBackend;

  beforeEach(() => {
    backend = new FireworksBackend(FIREWORKS_BASE, FIREWORKS_KEY);
    mockFetch.mockReset();
  });

  // -----------------------------------------------------------------------
  // Inheritance
  // -----------------------------------------------------------------------

  describe('identity', () => {
    it('is an instance of OpenAIBackend', () => {
      expect(backend).toBeInstanceOf(OpenAIBackend);
    });
  });

  // -----------------------------------------------------------------------
  // streamChat — wire format
  // -----------------------------------------------------------------------

  describe('streamChat', () => {
    it('yields text events from the SSE stream', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('DeepSeek'), chunk(' answer'), chunk('', true), '[DONE]']),
      });

      const events = [];
      for await (const e of backend.streamChat(FIREWORKS_MODEL, '', [{ role: 'user', content: 'hi' }])) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: 'text', text: 'DeepSeek' });
      expect(events).toContainEqual({ type: 'text', text: ' answer' });
    });

    it('sends the request to the Fireworks base URL', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: sseBody([chunk('ok', true), '[DONE]']) });

      for await (const _e of backend.streamChat(FIREWORKS_MODEL, '', [{ role: 'user', content: 'hi' }])) {
        // consume
      }

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('fireworks.ai');
      expect(url).toContain('/chat/completions');
    });

    it('sends Bearer authorization header', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: sseBody([chunk('ok', true), '[DONE]']) });

      for await (const _e of backend.streamChat(FIREWORKS_MODEL, '', [{ role: 'user', content: 'hi' }])) {
        // consume
      }

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe(`Bearer ${FIREWORKS_KEY}`);
    });

    it('includes the fully-qualified model id in the request body', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: sseBody([chunk('ok', true), '[DONE]']) });

      for await (const _e of backend.streamChat(FIREWORKS_MODEL, '', [{ role: 'user', content: 'hi' }])) {
        // consume
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.model).toBe(FIREWORKS_MODEL);
    });

    it('accumulates incremental tool call arguments', async () => {
      const tc = (id?: string, name?: string, args?: string) =>
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
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
          tc('tc_1', 'write_file', ''),
          tc(undefined, undefined, '{"path":"out.ts","content":""}'),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          '[DONE]',
        ]),
      });

      const events = [];
      for await (const e of backend.streamChat(FIREWORKS_MODEL, '', [{ role: 'user', content: 'write' }])) {
        events.push(e);
      }

      const toolEvent = events.find((e) => e.type === 'tool_use');
      expect(toolEvent).toBeDefined();
      if (toolEvent?.type === 'tool_use') {
        expect(toolEvent.toolUse.name).toBe('write_file');
        expect(toolEvent.toolUse.input).toEqual({ path: 'out.ts', content: '' });
      }
    });

    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers(),
        text: async () => 'Invalid API key',
      });

      await expect(async () => {
        for await (const _e of backend.streamChat(FIREWORKS_MODEL, '', [{ role: 'user', content: 'hi' }])) {
          // consume
        }
      }).rejects.toThrow('401');
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
      for await (const e of backend.streamChat(FIREWORKS_MODEL, '', [{ role: 'user', content: 'hi' }])) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: 'stop', stopReason: 'max_tokens' });
    });

    it('emits a stop event on finish_reason "stop"', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('done', true), '[DONE]']),
      });

      const events = [];
      for await (const e of backend.streamChat(FIREWORKS_MODEL, '', [{ role: 'user', content: 'hi' }])) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: 'stop', stopReason: 'end_turn' });
    });
  });

  // -----------------------------------------------------------------------
  // complete
  // -----------------------------------------------------------------------

  describe('complete', () => {
    it('returns text from a non-streaming response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Here is the code.' } }] }),
      });

      const result = await backend.complete(FIREWORKS_MODEL, '', [{ role: 'user', content: 'write?' }], 256);
      expect(result).toBe('Here is the code.');
    });

    it('returns empty string when choices is empty', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [] }) });
      const result = await backend.complete(FIREWORKS_MODEL, '', [{ role: 'user', content: 'hi' }], 256);
      expect(result).toBe('');
    });

    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers(),
        text: async () => 'Rate limited',
      });

      await expect(backend.complete(FIREWORKS_MODEL, '', [{ role: 'user', content: 'hi' }], 256)).rejects.toThrow(
        '429',
      );
    });
  });
});
