import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the kickstand token file so the bearer-token test is deterministic
// regardless of whether the host has ~/.config/kickstand/token set up.
// Without this, the assertion on line ~93 is wrapped in an `if (Authorization)`
// guard that silently no-ops on hosts without the token file (CI, fresh
// installs) — the test then passes without actually verifying the behavior.
// Same pattern as providerReachability.test.ts.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (p: string) => (p.includes('kickstand/token') ? true : actual.existsSync(p)),
    readFileSync: (p: string, enc?: BufferEncoding) =>
      p.includes('kickstand/token') ? 'test-kickstand-token' : actual.readFileSync(p, enc),
  };
});

import { KickstandBackend } from './kickstandBackend.js';

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

describe('KickstandBackend', () => {
  let backend: KickstandBackend;

  beforeEach(() => {
    backend = new KickstandBackend('http://localhost:11435');
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

    it('reads bearer token from ~/.config/kickstand/token automatically', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: sseBody([chunk('test', true), '[DONE]']),
      });

      for await (const _ of backend.streamChat('model', '', [{ role: 'user', content: 'test' }])) {
        // consume events
      }

      const call = mockFetch.mock.calls[0];
      const headers = call[1].headers;
      expect(headers).toHaveProperty('Content-Type', 'application/json');
      // With the fs mock at the top of this file, the token file is always
      // "present" — so Authorization must be set and must carry the stubbed
      // bearer value verbatim. Prior to the mock this assertion was wrapped
      // in an `if (headers.Authorization)` guard that made the test a silent
      // no-op on hosts without the real token file.
      expect(headers.Authorization).toBe('Bearer test-kickstand-token');
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
        /Kickstand API error 401/,
      );
    });
  });

  // v0.63.1 — KickstandBackend declares a lifecycle capability
  // wrapping the existing kickstandLoadModel / kickstandUnloadModel /
  // kickstandListRegistry helpers. These tests pin that the
  // capability hits the expected endpoints and returns the expected
  // shapes so callers (command palette, future model browser) can
  // rely on the contract.
  describe('nativeCapabilities — lifecycle (v0.63.1)', () => {
    it('advertises a lifecycle capability with loadModel / unloadModel / listLoadable', () => {
      const caps = backend.nativeCapabilities();
      expect(caps.lifecycle).toBeDefined();
      expect(typeof caps.lifecycle!.loadModel).toBe('function');
      expect(typeof caps.lifecycle!.unloadModel).toBe('function');
      expect(typeof caps.lifecycle!.listLoadable).toBe('function');
      // Does NOT advertise an OAI-compat fallback — Kickstand IS the
      // OAI-compat layer; there's no native chat endpoint to fall
      // back to.
      expect(caps.oaiCompatFallback).toBeUndefined();
    });

    it('loadModel hits /api/v1/models/{id}/load with auth header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok', model_id: 'qwen3:30b', socket: '/tmp/k.sock' }),
      });

      const caps = backend.nativeCapabilities();
      const summary = await caps.lifecycle!.loadModel('qwen3:30b');

      expect(summary).toContain('qwen3:30b');
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:11435/api/v1/models/qwen3%3A30b/load');
      expect((init as RequestInit).method).toBe('POST');
      const headers = (init as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBe('Bearer test-kickstand-token');
    });

    it('unloadModel hits /api/v1/models/{id}/unload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok', model_id: 'qwen3:30b' }),
      });

      const caps = backend.nativeCapabilities();
      const summary = await caps.lifecycle!.unloadModel('qwen3:30b');

      expect(summary).toContain('Unloaded qwen3:30b');
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:11435/api/v1/models/qwen3%3A30b/unload');
      expect((init as RequestInit).method).toBe('POST');
    });

    it('listLoadable normalizes the registry response to a flat { id, loaded, sizeBytes } shape', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            model_id: 'qwen3:30b',
            hf_repo: 'q/qwen3',
            filename: 'q.gguf',
            quant: 'Q4_K_M',
            size_bytes: 20_000_000_000,
            local_path: '/models/qwen3.gguf',
            status: 'ready',
            format: 'gguf',
            loaded: true,
          },
          {
            model_id: 'llama3:8b',
            hf_repo: 'm/llama3',
            filename: 'l.gguf',
            quant: null,
            size_bytes: null,
            local_path: '/models/llama3.gguf',
            status: 'ready',
            format: 'gguf',
            loaded: false,
          },
        ],
      });

      const caps = backend.nativeCapabilities();
      const loadable = await caps.lifecycle!.listLoadable!();

      expect(loadable).toEqual([
        { id: 'qwen3:30b', loaded: true, sizeBytes: 20_000_000_000 },
        { id: 'llama3:8b', loaded: false, sizeBytes: undefined },
      ]);
    });

    it('loadModel surfaces the Kickstand error message verbatim on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'out of memory',
      });
      const caps = backend.nativeCapabilities();
      await expect(caps.lifecycle!.loadModel('qwen3:30b')).rejects.toThrow(/Kickstand load failed.*500.*out of memory/);
    });
  });
});
