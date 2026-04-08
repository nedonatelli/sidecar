import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMManagerBackend } from './llmmanagerBackend.js';

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
    id: 'chatcmpl-test',
    object: 'text_completion.chunk',
    created: Date.now(),
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { content, role: 'assistant' },
        finish_reason: done ? 'stop' : null,
      },
    ],
  });
}

describe('LLMManagerBackend', () => {
  let backend: LLMManagerBackend;

  beforeEach(() => {
    backend = new LLMManagerBackend('http://localhost:11435', 'test-token');
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

    it('sends Authorization header with token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('test', true), '[DONE]']),
      });

      for await (const _ of backend.streamChat('model', '', [{ role: 'user', content: 'test' }])) {
        // consume events
      }

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11435/v1/chat/completions',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('sets stream: true in request body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('', true), '[DONE]']),
      });

      for await (const _ of backend.streamChat('model', '', [{ role: 'user', content: 'test' }])) {
        // consume events
      }

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.stream).toBe(true);
    });
  });

  describe('complete', () => {
    it('returns complete message content', async () => {
      const responseBody = {
        id: 'test-id',
        object: 'text_completion',
        created: Date.now(),
        model: 'test-model',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'This is a test response',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => responseBody,
      });

      const result = await backend.complete('model', '', [{ role: 'user', content: 'test' }], 256);

      expect(result).toBe('This is a test response');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11435/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('handles API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(backend.complete('model', '', [{ role: 'user', content: 'test' }], 256)).rejects.toThrow(
        /LLMManager API error 401/,
      );
    });
  });
});
