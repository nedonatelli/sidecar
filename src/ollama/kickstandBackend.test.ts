import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the kickstand token file so the bearer-token test is deterministic
// regardless of whether the host has ~/.config/kickstand/token set up.
// Previously inline here; centralized in v0.65 so
// providerReachability.test.ts + this file share a single source of truth.
vi.mock('fs', async () => {
  const { buildKickstandTokenFsMock } = await import('../__tests__/helpers/kickstandToken.js');
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return buildKickstandTokenFsMock(actual);
});

import {
  KickstandBackend,
  kickstandPullModel,
  kickstandListRegistry,
  kickstandLoadModel,
  kickstandUnloadModel,
  kickstandListAdapters,
  kickstandLoadAdapter,
  kickstandUnloadAdapter,
  kickstandBrowseRepo,
  normalizeHfRepo,
} from './kickstandBackend.js';

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

    it('auto-reloads with configured nCtx on context-overflow 400 and retries', async () => {
      const overflowBody = JSON.stringify({
        error: { message: 'Prompt too long for model context window. load model with larger n_ctx.' },
      });
      // First call: context overflow
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => overflowBody });
      // Unload call
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'unloaded', model_id: 'mymodel' }) });
      // Load call
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'loaded', model_id: 'mymodel' }) });
      // Retry chat: success
      mockFetch.mockResolvedValueOnce({ ok: true, body: sseBody([chunk('hi', true), '[DONE]']) });

      const b = new KickstandBackend('http://localhost:11435', undefined, 16384);
      const events = [];
      for await (const ev of b.streamChat('mymodel', '', [{ role: 'user', content: 'hello' }])) {
        events.push(ev);
      }

      expect(events).toContainEqual({ type: 'text', text: 'hi' });
      // load call should have used nCtx=16384
      const loadBody = JSON.parse(mockFetch.mock.calls[2][1].body as string) as { n_ctx: number };
      expect(loadBody.n_ctx).toBe(16384);
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

// ---------------------------------------------------------------------------
// Module-level helpers — exercise the pull / list / load / unload exports
// directly so coverage isn't bottlenecked on the nativeCapabilities wrapper.
// ---------------------------------------------------------------------------

function pullSseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        controller.enqueue(encoder.encode(lines.map((l) => `data: ${l}\n`).join('')));
        sent = true;
      } else {
        controller.close();
      }
    },
  });
}

describe('normalizeHfRepo', () => {
  it('passes plain owner/repo through unchanged', () => {
    expect(normalizeHfRepo('bartowski/Llama-3-8B-GGUF')).toBe('bartowski/Llama-3-8B-GGUF');
  });

  it('strips https://huggingface.co/ prefix', () => {
    expect(normalizeHfRepo('https://huggingface.co/bartowski/Llama-3-8B-GGUF')).toBe('bartowski/Llama-3-8B-GGUF');
  });

  it('strips trailing slashes', () => {
    expect(normalizeHfRepo('bartowski/Llama-3-8B-GGUF/')).toBe('bartowski/Llama-3-8B-GGUF');
  });

  it('handles URL + trailing slash', () => {
    expect(normalizeHfRepo('https://huggingface.co/bartowski/Llama-3-8B-GGUF/')).toBe('bartowski/Llama-3-8B-GGUF');
  });
});

describe('kickstandPullModel', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('yields every JSON-parseable SSE event in order', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: pullSseBody([
        JSON.stringify({ status: 'downloading', repo: 'q/q', filename: 'q.gguf' }),
        JSON.stringify({ status: 'done', local_path: '/m/q.gguf', format: 'gguf' }),
      ]),
    });

    const events = [];
    for await (const e of kickstandPullModel('http://localhost:11435', 'q/q', 'q.gguf')) {
      events.push(e);
    }

    expect(events).toEqual([
      { status: 'downloading', repo: 'q/q', filename: 'q.gguf' },
      { status: 'done', local_path: '/m/q.gguf', format: 'gguf' },
    ]);

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { repo: string; filename: string };
    expect(body.repo).toBe('q/q');
    expect(body.filename).toBe('q.gguf');
  });

  it('forwards hfToken in the request body when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: pullSseBody([JSON.stringify({ status: 'done' })]),
    });
    // Drain the generator so the fetch is dispatched.
    for await (const _ of kickstandPullModel('http://localhost:11435', 'q/q', undefined, 'hf_SECRET')) {
      void _;
    }
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { token?: string };
    expect(body.token).toBe('hf_SECRET');
  });

  it('yields a single error event when the initial response is not OK', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'repo not found',
    });
    const events = [];
    for await (const e of kickstandPullModel('http://localhost:11435', 'missing/repo')) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('error');
    expect(events[0].message).toContain('404');
    expect(events[0].message).toContain('repo not found');
  });

  it('yields an error event when the response body is empty', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, body: null });
    const events = [];
    for await (const e of kickstandPullModel('http://localhost:11435', 'q/q')) {
      events.push(e);
    }
    expect(events).toEqual([{ status: 'error', message: 'Kickstand returned an empty response body' }]);
  });

  it('skips malformed SSE lines without bubbling a parse error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: pullSseBody([
        'not-json-at-all',
        JSON.stringify({ status: 'downloading' }),
        '{bad json}',
        JSON.stringify({ status: 'done' }),
      ]),
    });
    const events = [];
    for await (const e of kickstandPullModel('http://localhost:11435', 'q/q')) {
      events.push(e);
    }
    expect(events).toEqual([{ status: 'downloading' }, { status: 'done' }]);
  });

  it('ignores lines that are not prefixed with "data:"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              [': comment', 'event: progress', `data: ${JSON.stringify({ status: 'done' })}`].join('\n') + '\n',
            ),
          );
          controller.close();
        },
      }),
    });
    const events = [];
    for await (const e of kickstandPullModel('http://localhost:11435', 'q/q')) {
      events.push(e);
    }
    expect(events).toEqual([{ status: 'done' }]);
  });

  it('strips trailing slashes from baseUrl when building the pull URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: pullSseBody([JSON.stringify({ status: 'done' })]),
    });
    for await (const _ of kickstandPullModel('http://localhost:11435///', 'q/q')) {
      void _;
    }
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11435/api/v1/models/pull');
  });
});

describe('kickstandListRegistry', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns the parsed registry array on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ model_id: 'q/q', status: 'ready', loaded: false }],
    });
    const rows = await kickstandListRegistry('http://localhost:11435');
    expect(rows).toEqual([{ model_id: 'q/q', status: 'ready', loaded: false }]);
  });

  it('returns [] when the registry endpoint returns non-OK', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const rows = await kickstandListRegistry('http://localhost:11435');
    expect(rows).toEqual([]);
  });
});

describe('kickstandLoadModel', () => {
  beforeEach(() => mockFetch.mockReset());

  it('passes n_gpu_layers and n_ctx options into the request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', model_id: 'q/q' }),
    });
    await kickstandLoadModel('http://localhost:11435', 'q/q', { n_gpu_layers: 32, n_ctx: 16384 });
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as { n_gpu_layers: number; n_ctx: number };
    expect(body.n_gpu_layers).toBe(32);
    expect(body.n_ctx).toBe(16384);
  });

  it('applies default n_gpu_layers=-1 / n_ctx=4096 when options are omitted', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', model_id: 'q/q' }),
    });
    await kickstandLoadModel('http://localhost:11435', 'q/q');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { n_gpu_layers: number; n_ctx: number };
    expect(body.n_gpu_layers).toBe(-1);
    expect(body.n_ctx).toBe(4096);
  });
});

describe('kickstandUnloadModel', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns the parsed response on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', model_id: 'q/q' }),
    });
    const result = await kickstandUnloadModel('http://localhost:11435', 'q/q');
    expect(result).toEqual({ status: 'ok', model_id: 'q/q' });
  });

  it('throws with the Kickstand-prefixed error message on non-OK', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'model not loaded',
    });
    await expect(kickstandUnloadModel('http://localhost:11435', 'q/q')).rejects.toThrow(
      /Kickstand unload failed.*404.*model not loaded/,
    );
  });
});

// ---------------------------------------------------------------------------
// LoRA adapter + model browser tests (v0.67.0, chunk 8 closure)
//
// The LoRA + browser endpoints shipped in 83b4418 without test coverage.
// These suites close the gap — one describe per function, happy + error
// paths for each. Kickstand's live API shape is documented by the server
// at /Users/nedonatelli/Documents/llmmanager/api/routes/models.py.
// ---------------------------------------------------------------------------

describe('kickstandListAdapters', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns the adapters array when the server responds with { adapters: [...] }', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_id: 'base/q',
        adapters: [
          { id: 'ad-1', path: '/a/one.gguf', scale: 1.0 },
          { id: 'ad-2', path: '/a/two.gguf', scale: 0.5 },
        ],
      }),
    });
    const out = await kickstandListAdapters('http://localhost:11435', 'base/q');
    expect(out).toEqual([
      { id: 'ad-1', path: '/a/one.gguf', scale: 1.0 },
      { id: 'ad-2', path: '/a/two.gguf', scale: 0.5 },
    ]);
  });

  it('returns the body directly when the server responds with a bare array (fallback shape)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 'ad-1', path: '/a.gguf', scale: 1 }],
    });
    const out = await kickstandListAdapters('http://localhost:11435', 'base');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('ad-1');
  });

  it('returns an empty array on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' });
    const out = await kickstandListAdapters('http://localhost:11435', 'missing');
    expect(out).toEqual([]);
  });

  it('URL-encodes the model id path segment', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ adapters: [] }) });
    await kickstandListAdapters('http://localhost:11435', 'org/model:tag');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/models/org%2Fmodel%3Atag/lora');
  });
});

describe('kickstandLoadAdapter', () => {
  beforeEach(() => mockFetch.mockReset());

  it('POSTs to the per-model lora endpoint with path + scale and returns the adapter_id', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'loaded', model_id: 'base', adapter_id: 'ad-xyz', scale: 0.75 }),
    });
    const result = await kickstandLoadAdapter('http://localhost:11435', 'base', '/a/lora.gguf', 0.75);
    expect(result.adapter_id).toBe('ad-xyz');
    expect(result.status).toBe('loaded');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/models/base/lora');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ path: '/a/lora.gguf', scale: 0.75 });
  });

  it('defaults scale to 1.0 when omitted by the caller', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ adapter_id: 'ad-1', status: 'loaded' }),
    });
    await kickstandLoadAdapter('http://localhost:11435', 'base', '/a/lora.gguf');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { scale: number };
    expect(body.scale).toBe(1.0);
  });

  it('throws with status + body on non-OK', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "'path' is required",
    });
    await expect(kickstandLoadAdapter('http://localhost:11435', 'base', '/a.gguf')).rejects.toThrow(
      /LoRA load failed.*400.*'path' is required/,
    );
  });
});

describe('kickstandUnloadAdapter', () => {
  beforeEach(() => mockFetch.mockReset());

  it('DELETEs the per-adapter URL and returns the parsed response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'unloaded', model_id: 'base', adapter_id: 'ad-1' }),
    });
    const out = await kickstandUnloadAdapter('http://localhost:11435', 'base', 'ad-1');
    expect(out.status).toBe('unloaded');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/models/base/lora/ad-1');
    expect(init.method).toBe('DELETE');
  });

  it('URL-encodes both model id and adapter id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'unloaded' }) });
    await kickstandUnloadAdapter('http://localhost:11435', 'org/model', 'ad/with/slash');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/models/org%2Fmodel/lora/ad%2Fwith%2Fslash');
  });

  it('throws with Kickstand-prefixed message on non-OK', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'adapter not found',
    });
    await expect(kickstandUnloadAdapter('http://localhost:11435', 'base', 'ad-missing')).rejects.toThrow(
      /LoRA unload failed.*404.*adapter not found/,
    );
  });
});

describe('kickstandBrowseRepo', () => {
  beforeEach(() => mockFetch.mockReset());

  it('maps snake_case server fields to camelCase client shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { filename: 'model-q4_k_m.gguf', size_bytes: 4_700_000_000, quant: 'Q4_K_M', format: 'gguf' },
        { filename: 'model-fp16.mlx', size_bytes: 16_000_000_000, quant: null, format: 'mlx' },
      ],
    });
    const out = await kickstandBrowseRepo('http://localhost:11435', 'org/repo');
    expect(out).toEqual([
      { filename: 'model-q4_k_m.gguf', sizeBytes: 4_700_000_000, quant: 'Q4_K_M', format: 'gguf' },
      { filename: 'model-fp16.mlx', sizeBytes: 16_000_000_000, quant: undefined, format: 'mlx' },
    ]);
  });

  it('throws with Kickstand-prefixed message on non-OK', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'hf rate limited',
    });
    await expect(kickstandBrowseRepo('http://localhost:11435', 'org/repo')).rejects.toThrow(
      /Browse failed.*429.*hf rate limited/,
    );
  });

  it('builds the URL with the repo suffix (no double-encoding of the slash)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await kickstandBrowseRepo('http://localhost:11435', 'bartowski/Meta-Llama-3-8B-Instruct-GGUF');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:11435/api/v1/models/browse/bartowski/Meta-Llama-3-8B-Instruct-GGUF');
  });
});

// ---------------------------------------------------------------------------
// Capability wiring on the KickstandBackend class
// ---------------------------------------------------------------------------

describe('KickstandBackend.nativeCapabilities — loraAdapters + modelBrowser', () => {
  let backend: KickstandBackend;

  beforeEach(() => {
    backend = new KickstandBackend('http://localhost:11435');
    mockFetch.mockReset();
  });

  it('exposes a loraAdapters capability with list / load / unload methods', () => {
    const caps = backend.nativeCapabilities();
    expect(caps?.loraAdapters).toBeDefined();
    expect(typeof caps?.loraAdapters?.listAdapters).toBe('function');
    expect(typeof caps?.loraAdapters?.loadAdapter).toBe('function');
    expect(typeof caps?.loraAdapters?.unloadAdapter).toBe('function');
  });

  it('exposes a modelBrowser capability with browseRepo', () => {
    const caps = backend.nativeCapabilities();
    expect(caps?.modelBrowser).toBeDefined();
    expect(typeof caps?.modelBrowser?.browseRepo).toBe('function');
  });

  it('loraAdapters.loadAdapter returns a user-facing summary string on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ adapter_id: 'ad-new', status: 'loaded' }),
    });
    const caps = backend.nativeCapabilities();
    const summary = await caps!.loraAdapters!.loadAdapter('base', '/a/lora.gguf', 0.8);
    // The command layer shows this string directly to the user, so verify it
    // names both the model and the returned adapter id.
    expect(summary).toMatch(/ad-new/);
    expect(summary).toMatch(/base/);
  });

  it('loraAdapters.unloadAdapter returns a user-facing summary string on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'unloaded', model_id: 'base', adapter_id: 'ad-1' }),
    });
    const caps = backend.nativeCapabilities();
    const summary = await caps!.loraAdapters!.unloadAdapter('base', 'ad-1');
    expect(summary).toMatch(/ad-1/);
    expect(summary).toMatch(/base/);
  });
});
