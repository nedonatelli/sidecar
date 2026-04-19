import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroqBackend } from './groqBackend.js';
import { OpenAIBackend } from './openaiBackend.js';

// ---------------------------------------------------------------------------
// GroqBackend tests (v0.69 chunk 5).
//
// GroqBackend is an empty subclass of OpenAIBackend — its value is provider
// isolation (circuit breaker, rate-limit store, detectProvider routing) and
// a named type, not new protocol logic. These tests confirm:
//   1. Inheritance: it is an OpenAIBackend at runtime.
//   2. Wire format: it hits the user-supplied base URL, sends Bearer auth,
//      and the full SSE → StreamEvent chain works.
//   3. Tool calls: incremental argument accumulation (inherited) works.
//   4. Error handling: non-OK responses throw the expected error shape.
//   5. complete(): non-streaming path works.
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GROQ_KEY = 'gsk_test123';

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

describe('GroqBackend', () => {
  let backend: GroqBackend;

  beforeEach(() => {
    backend = new GroqBackend(GROQ_BASE, GROQ_KEY);
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
        body: sseBody([chunk('Fast'), chunk(' reply'), chunk('', true), '[DONE]']),
      });

      const events = [];
      for await (const e of backend.streamChat('llama3-8b-8192', '', [{ role: 'user', content: 'hi' }])) {
        events.push(e);
      }

      expect(events).toContainEqual({ type: 'text', text: 'Fast' });
      expect(events).toContainEqual({ type: 'text', text: ' reply' });
    });

    it('sends the request to the Groq base URL', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: sseBody([chunk('ok', true), '[DONE]']) });

      for await (const _e of backend.streamChat('llama3-8b-8192', '', [{ role: 'user', content: 'hi' }])) {
        // consume
      }

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('api.groq.com');
      expect(url).toContain('/chat/completions');
    });

    it('sends Bearer authorization header', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: sseBody([chunk('ok', true), '[DONE]']) });

      for await (const _e of backend.streamChat('llama3-8b-8192', '', [{ role: 'user', content: 'hi' }])) {
        // consume
      }

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe(`Bearer ${GROQ_KEY}`);
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
          tc('tc_1', 'read_file', ''),
          tc(undefined, undefined, '{"path":"src/main.ts"}'),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          '[DONE]',
        ]),
      });

      const events = [];
      for await (const e of backend.streamChat('llama3-8b-8192', '', [{ role: 'user', content: 'read' }])) {
        events.push(e);
      }

      const toolEvent = events.find((e) => e.type === 'tool_use');
      expect(toolEvent).toBeDefined();
      if (toolEvent?.type === 'tool_use') {
        expect(toolEvent.toolUse.name).toBe('read_file');
        expect(toolEvent.toolUse.input).toEqual({ path: 'src/main.ts' });
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
        for await (const _e of backend.streamChat('llama3-8b-8192', '', [{ role: 'user', content: 'hi' }])) {
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
      for await (const e of backend.streamChat('llama3-8b-8192', '', [{ role: 'user', content: 'hi' }])) {
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
      for await (const e of backend.streamChat('llama3-8b-8192', '', [{ role: 'user', content: 'hi' }])) {
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
        json: async () => ({ choices: [{ message: { content: 'Groq is fast.' } }] }),
      });

      const result = await backend.complete('llama3-8b-8192', '', [{ role: 'user', content: 'speed?' }], 256);
      expect(result).toBe('Groq is fast.');
    });

    it('returns empty string when choices is empty', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [] }) });
      const result = await backend.complete('llama3-8b-8192', '', [{ role: 'user', content: 'hi' }], 256);
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

      await expect(backend.complete('llama3-8b-8192', '', [{ role: 'user', content: 'hi' }], 256)).rejects.toThrow(
        '429',
      );
    });
  });
});
