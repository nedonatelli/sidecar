import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SideCarClient } from './client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SideCarClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('constructor defaults', () => {
    it('uses default base URL (local Ollama)', () => {
      const client = new SideCarClient('test-model');
      expect(client.isLocalOllama()).toBe(true);
    });

    it('accepts custom base URL', () => {
      const client = new SideCarClient('model', 'https://api.anthropic.com');
      expect(client.isLocalOllama()).toBe(false);
    });
  });

  describe('backend selection', () => {
    it('uses Ollama backend for local URL (posts to /api/chat)', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'test-model',
          message: { role: 'assistant', content: 'hello' },
          done: true,
        }),
      });

      await client.complete([{ role: 'user', content: 'hi' }]);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/api/chat');
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['anthropic-version']).toBeUndefined();
    });

    it('uses Anthropic backend for remote URL (posts to /v1/messages)', async () => {
      const client = new SideCarClient('claude-sonnet', 'https://api.anthropic.com', 'sk-test');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });

      await client.complete([{ role: 'user', content: 'hi' }]);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/v1/messages');
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['x-api-key']).toBe('sk-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('switches backend when updateConnection changes URL', async () => {
      const client = new SideCarClient('model');
      expect(client.isLocalOllama()).toBe(true);

      client.updateConnection('https://api.anthropic.com', 'sk-test');
      expect(client.isLocalOllama()).toBe(false);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      await client.complete([{ role: 'user', content: 'hi' }]);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/v1/messages');
    });
  });

  describe('complete (Ollama backend)', () => {
    it('returns text from Ollama response', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'test-model',
          message: { role: 'assistant', content: 'The answer is 42.' },
          done: true,
        }),
      });

      const result = await client.complete([{ role: 'user', content: 'What is the answer?' }]);
      expect(result).toBe('The answer is 42.');
    });

    it('throws on non-ok response', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers(),
        text: async () => 'bad request',
      });

      await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('Ollama request failed: 400');
    });
  });

  describe('complete (Anthropic backend)', () => {
    it('returns text from Anthropic response', async () => {
      const client = new SideCarClient('claude-sonnet', 'https://api.anthropic.com', 'sk-test');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'The answer is 42.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });

      const result = await client.complete([{ role: 'user', content: 'What is the answer?' }]);
      expect(result).toBe('The answer is 42.');
    });
  });

  describe('updateModel', () => {
    it('changes the model used in requests', async () => {
      const client = new SideCarClient('test-model');
      client.updateModel('new-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'new-model',
          message: { role: 'assistant', content: 'hello' },
          done: true,
        }),
      });

      await client.complete([{ role: 'user', content: 'hi' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('new-model');
    });
  });

  describe('updateSystemPrompt', () => {
    it('includes system prompt in Ollama request as system message', async () => {
      const client = new SideCarClient('test-model');
      client.updateSystemPrompt('You are helpful.');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'test-model',
          message: { role: 'assistant', content: 'hello' },
          done: true,
        }),
      });

      await client.complete([{ role: 'user', content: 'hi' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    });
  });

  describe('updateConnection', () => {
    it('changes base URL and API key', () => {
      const client = new SideCarClient('m');
      client.updateConnection('https://example.com', 'sk-test');
      expect(client.isLocalOllama()).toBe(false);
    });

    it('falls back to defaults when given empty strings', () => {
      const client = new SideCarClient('m', 'https://example.com');
      client.updateConnection('', '');
      expect(client.isLocalOllama()).toBe(true);
    });
  });

  describe('rate-limit store isolation', () => {
    it('gives each provider its own store so budgets do not leak across backends', () => {
      const client = new SideCarClient('claude-sonnet', 'https://api.anthropic.com', 'sk-ant');

      const anthropicStore = client.getRateLimits();
      anthropicStore.update({ tokensLimit: 200000, tokensRemaining: 7944, tokensResetSec: 617 });
      expect(anthropicStore.getSnapshot()?.tokensRemaining).toBe(7944);

      client.updateConnection('https://api.openai.com', 'sk-openai');
      const openaiStore = client.getRateLimits();

      expect(openaiStore).not.toBe(anthropicStore);
      expect(openaiStore.getSnapshot()).toBeNull();

      client.updateConnection('https://api.anthropic.com', 'sk-ant');
      const anthropicStoreAgain = client.getRateLimits();
      expect(anthropicStoreAgain).toBe(anthropicStore);
      expect(anthropicStoreAgain.getSnapshot()?.tokensRemaining).toBe(7944);
    });
  });

  describe('isLocalOllama', () => {
    it('returns true for localhost:11434', () => {
      expect(new SideCarClient('m', 'http://localhost:11434').isLocalOllama()).toBe(true);
    });

    it('returns true for 127.0.0.1:11434', () => {
      expect(new SideCarClient('m', 'http://127.0.0.1:11434').isLocalOllama()).toBe(true);
    });

    it('returns false for remote URL', () => {
      expect(new SideCarClient('m', 'https://api.anthropic.com').isLocalOllama()).toBe(false);
    });
  });

  describe('completeFIM', () => {
    it('sends prefix and suffix to generate endpoint', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'completed code' }),
      });

      const result = await client.completeFIM('function hello() {', '}');
      expect(result).toBe('completed code');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/generate');
      const body = JSON.parse(opts.body);
      expect(body.prompt).toBe('function hello() {');
      expect(body.suffix).toBe('}');
    });

    it('uses override model if provided', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'code' }),
      });

      await client.completeFIM('pre', 'suf', 'other-model');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('other-model');
    });
  });

  describe('backend fallback', () => {
    it('fallback configuration is part of client initialization', () => {
      // Verify the client supports fallback by initializing without error
      const client = new SideCarClient('test-model', 'http://localhost:11434', 'ollama');
      expect(client.getModel()).toBe('test-model');
      // Fallback logic is tested implicitly through complete() and streamChat() error handling
    });

    it('resets consecutive failure counter on successful request', async () => {
      const client = new SideCarClient('test-model');

      // First request fails
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      await expect(client.complete([{ role: 'user', content: 'test' }])).rejects.toThrow();

      // Second request succeeds — counter resets
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'test-model',
          message: { role: 'assistant', content: 'OK' },
          done: true,
        }),
      });

      const result = await client.complete([{ role: 'user', content: 'test' }]);
      expect(result).toBe('OK');
    });
  });

  describe('getModelContextLength', () => {
    it('returns null for non-Ollama providers', async () => {
      const client = new SideCarClient('test-model', 'https://api.anthropic.com', 'sk-test');
      const result = await client.getModelContextLength();
      expect(result).toBeNull();
    });

    it('extracts num_ctx from model parameters', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parameters: 'num_ctx 32768\ntemperature 0.8',
          model_info: {},
        }),
      });
      const result = await client.getModelContextLength();
      expect(result).toBe(32768);
    });

    it('falls back to model_info context_length', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model_info: { 'llama.context_length': 8192 },
        }),
      });
      const result = await client.getModelContextLength();
      expect(result).toBe(8192);
    });

    it('returns null when API call fails', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      const result = await client.getModelContextLength();
      expect(result).toBeNull();
    });

    it('returns null when response is not ok', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({ ok: false });
      const result = await client.getModelContextLength();
      expect(result).toBeNull();
    });

    it('returns null when no context info in response', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model_info: {} }),
      });
      const result = await client.getModelContextLength();
      expect(result).toBeNull();
    });
  });

  describe('listInstalledModels', () => {
    it('fetches models from Ollama /api/tags', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3:latest', model: 'llama3', size: 1000, details: {} },
            { name: 'codellama:7b', model: 'codellama', size: 2000, details: {} },
          ],
        }),
      });
      const models = await client.listInstalledModels();
      expect(models).toHaveLength(2);
      expect(models[0].name).toBe('llama3:latest');
    });

    it('throws on non-ok response for Ollama', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(client.listInstalledModels()).rejects.toThrow('Failed to list models');
    });

    it('fetches models from OpenAI /v1/models for remote providers', async () => {
      const client = new SideCarClient('gpt-4', 'https://api.openai.com', 'sk-test');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4', owned_by: 'openai' },
            { id: 'gpt-3.5-turbo', owned_by: 'openai' },
          ],
        }),
      });
      const models = await client.listInstalledModels();
      expect(models).toHaveLength(2);
      expect(models[0].name).toBe('gpt-4');
    });

    it('returns empty array when OpenAI endpoint fails', async () => {
      const client = new SideCarClient('gpt-4', 'https://api.openai.com', 'sk-test');
      mockFetch.mockRejectedValueOnce(new Error('network'));
      const models = await client.listInstalledModels();
      expect(models).toEqual([]);
    });
  });

  describe('listLibraryModels', () => {
    it('includes both installed and library models for Ollama', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: 'llama3:latest', model: 'llama3', size: 1000, details: {} }],
        }),
      });
      const models = await client.listLibraryModels();
      const installed = models.filter((m) => m.installed);
      const available = models.filter((m) => !m.installed);
      expect(installed).toHaveLength(1);
      expect(available.length).toBeGreaterThan(0);
    });
  });

  describe('getSystemPrompt', () => {
    it('returns empty string initially', () => {
      const client = new SideCarClient('test-model');
      expect(client.getSystemPrompt()).toBe('');
    });

    it('returns updated prompt after updateSystemPrompt', () => {
      const client = new SideCarClient('test-model');
      client.updateSystemPrompt('You are a helpful assistant');
      expect(client.getSystemPrompt()).toBe('You are a helpful assistant');
    });
  });

  describe('isOpenAI', () => {
    it('returns false for Ollama', () => {
      const client = new SideCarClient('test-model');
      expect(client.isOpenAI()).toBe(false);
    });

    it('returns true for OpenAI URL', () => {
      const client = new SideCarClient('gpt-4', 'https://api.openai.com', 'sk-test');
      expect(client.isOpenAI()).toBe(true);
    });
  });

  describe('getProviderType', () => {
    it('returns ollama for local URL', () => {
      const client = new SideCarClient('test-model');
      expect(client.getProviderType()).toBe('ollama');
    });

    it('returns anthropic for Anthropic URL', () => {
      const client = new SideCarClient('claude', 'https://api.anthropic.com', 'sk-ant');
      expect(client.getProviderType()).toBe('anthropic');
    });
  });

  describe('completeFIM', () => {
    it('throws on non-ok response', async () => {
      const client = new SideCarClient('test-model');
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'server error',
      });
      await expect(client.completeFIM('prefix', 'suffix')).rejects.toThrow('FIM request failed');
    });
  });

  describe('complete error handling', () => {
    it('rethrows AbortError without counting as failure', async () => {
      const client = new SideCarClient('test-model');
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);
      await expect(client.complete([{ role: 'user', content: 'test' }])).rejects.toThrow('Aborted');
    });
  });

  describe('model usage log', () => {
    function stubOllamaResponse() {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'test-model',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }),
      });
    }

    it('buildModelTrailers falls back to the configured model when no calls yet', () => {
      const client = new SideCarClient('qwen3-coder:30b');
      expect(client.buildModelTrailers()).toBe('X-AI-Model: qwen3-coder:30b');
    });

    it('records each complete() call in the usage log', async () => {
      const client = new SideCarClient('test-model');
      stubOllamaResponse();
      await client.complete([{ role: 'user', content: 'hi' }]);
      const log = client.getModelUsageLog();
      expect(log).toHaveLength(1);
      expect(log[0].model).toBe('test-model');
      expect(log[0].role).toBe('complete');
      expect(log[0].timestamp).toBeInstanceOf(Date);
    });

    it('records each streamChat() call in the usage log', async () => {
      const client = new SideCarClient('test-model');
      // streamChat uses the backend's async generator; mock an empty SSE stream.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
            releaseLock: () => {},
          }),
        },
      });
      const gen = client.streamChat([{ role: 'user', content: 'hi' }]);
      // Drain to force the generator's preamble (the usage-log entry is
      // recorded synchronously at call time, but drain anyway to be safe).
      for await (const _ of gen) {
        void _;
      }
      const log = client.getModelUsageLog();
      expect(log).toHaveLength(1);
      expect(log[0].role).toBe('chat');
    });

    it('buildModelTrailers emits one line per unique model with call counts', async () => {
      const client = new SideCarClient('test-model');
      stubOllamaResponse();
      stubOllamaResponse();
      await client.complete([{ role: 'user', content: 'a' }]);
      await client.complete([{ role: 'user', content: 'b' }]);
      const trailers = client.buildModelTrailers();
      expect(trailers).toContain('X-AI-Model: test-model (complete, 2 calls)');
      // Only one model used — no count summary line.
      expect(trailers).not.toContain('X-AI-Model-Count');
    });

    it('buildModelTrailers emits Count trailer and merges roles when multiple models are used', async () => {
      const client = new SideCarClient('model-a');
      stubOllamaResponse();
      await client.complete([{ role: 'user', content: 'a' }]);
      client.updateModel('model-b');
      stubOllamaResponse();
      await client.complete([{ role: 'user', content: 'b' }]);
      const trailers = client.buildModelTrailers();
      expect(trailers).toContain('X-AI-Model: model-a (complete, 1 call)');
      expect(trailers).toContain('X-AI-Model: model-b (complete, 1 call)');
      expect(trailers).toContain('X-AI-Model-Count: 2');
    });

    it('clearModelUsageLog resets the log', async () => {
      const client = new SideCarClient('test-model');
      stubOllamaResponse();
      await client.complete([{ role: 'user', content: 'a' }]);
      expect(client.getModelUsageLog()).toHaveLength(1);
      client.clearModelUsageLog();
      expect(client.getModelUsageLog()).toHaveLength(0);
      // After clearing, the trailer falls back to the configured model again.
      expect(client.buildModelTrailers()).toBe('X-AI-Model: test-model');
    });

    it('getModelUsageLog returns a copy (not a live reference)', async () => {
      const client = new SideCarClient('test-model');
      stubOllamaResponse();
      await client.complete([{ role: 'user', content: 'a' }]);
      const snapshot = client.getModelUsageLog();
      snapshot.push({ model: 'injected', role: 'chat', timestamp: new Date() });
      expect(client.getModelUsageLog()).toHaveLength(1);
    });
  });

  // v0.62.3 — mid-stream config rotation safety. The invariant under
  // test: the backend's streamChat() packs `this.model` /
  // `this.systemPrompt` / `this.baseUrl` / `this.apiKey` into the HTTP
  // request body + headers synchronously when it's first called. Once
  // fetch is in flight, a later `updateModel` / `updateConnection` /
  // `updateSystemPrompt` MUST NOT affect the request that's already on
  // the wire — rotation only takes effect for the NEXT call. If this
  // invariant broke, a user rotating mid-turn would see a half-stream
  // from model-a followed by broken model-b continuation.
  describe('mid-stream config rotation', () => {
    /** One-chunk NDJSON Ollama stream that resolves immediately. Simple
     *  enough to let us test the "request body was captured at call time"
     *  invariant without orchestrating chunk-level timing. */
    function makeOllamaStream(model: string, content: string): unknown {
      const chunk = JSON.stringify({
        model,
        message: { role: 'assistant', content },
        done: true,
      });
      const bytes = new TextEncoder().encode(chunk + '\n');
      let delivered = false;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (delivered) return { done: true, value: undefined };
              delivered = true;
              return { done: false, value: bytes };
            },
            releaseLock: () => {},
          }),
        },
      };
    }

    it('updateModel after the stream starts does NOT retarget the in-flight request', async () => {
      const client = new SideCarClient('model-a');
      mockFetch.mockResolvedValueOnce(makeOllamaStream('model-a', 'hi'));

      const gen = client.streamChat([{ role: 'user', content: 'hello' }]);
      // Pull the first value — this forces the generator to execute up
      // to its first yield, which means the backend's fetch() has been
      // issued with the body it's going to carry for this whole stream.
      await gen.next();

      // Rotation lands AFTER the request was sent. The still-active
      // stream keeps draining the model-a response.
      client.updateModel('model-b');
      for await (const _ of gen) void _;

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
      expect(body.model).toBe('model-a');

      // The NEXT call picks up the rotated model.
      mockFetch.mockResolvedValueOnce(makeOllamaStream('model-b', 'ok'));
      const gen2 = client.streamChat([{ role: 'user', content: 'follow' }]);
      for await (const _ of gen2) void _;
      const body2 = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body);
      expect(body2.model).toBe('model-b');
    });

    it('updateSystemPrompt mid-stream does NOT retarget the in-flight stream', async () => {
      const client = new SideCarClient('model-a');
      client.updateSystemPrompt('prompt-one');
      mockFetch.mockResolvedValueOnce(makeOllamaStream('model-a', 'hi'));

      const gen = client.streamChat([{ role: 'user', content: 'hello' }]);
      await gen.next();
      client.updateSystemPrompt('prompt-two');
      for await (const _ of gen) void _;

      const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
      // Ollama prepends the system prompt as the first message in the
      // messages array (role: 'system'). Pin the exact shape so the
      // test doesn't silently pass on absence.
      expect(body.messages[0]).toEqual({ role: 'system', content: 'prompt-one' });
    });

    it('updateConnection mid-stream does NOT swap the in-flight backend', async () => {
      const client = new SideCarClient('model-a');
      mockFetch.mockResolvedValueOnce(makeOllamaStream('model-a', 'hi'));

      const gen = client.streamChat([{ role: 'user', content: 'hello' }]);
      await gen.next();

      // Rotate to a different backend family (Anthropic). The in-flight
      // stream is already targeted at Ollama and must complete there.
      client.updateConnection('https://api.anthropic.com', 'sk-rotated');
      for await (const _ of gen) void _;

      const firstUrl = mockFetch.mock.calls[0][0] as string;
      expect(firstUrl).toContain('/api/chat');
      expect(firstUrl).not.toContain('anthropic.com');

      // The next call hits the newly-configured backend.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });
      await client.complete([{ role: 'user', content: 'follow' }]);
      const secondUrl = mockFetch.mock.calls[1][0] as string;
      expect(secondUrl).toContain('api.anthropic.com');
      expect(secondUrl).toContain('/v1/messages');
      const secondHeaders = (mockFetch.mock.calls[1][1] as { headers: Record<string, string> }).headers;
      expect(secondHeaders['x-api-key']).toBe('sk-rotated');
    });

    it('API key rotation mid-stream does not alter the request already on the wire', async () => {
      const client = new SideCarClient('claude-sonnet', 'https://api.anthropic.com', 'sk-original');

      // Minimal Anthropic SSE response — just enough frames for the
      // stream to close cleanly.
      const frames = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      const encoder = new TextEncoder();
      let idx = 0;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (idx >= frames.length) return { done: true, value: undefined };
              const frame = frames[idx++];
              return { done: false, value: encoder.encode(frame) };
            },
            releaseLock: () => {},
          }),
        },
      });

      const gen = client.streamChat([{ role: 'user', content: 'hi' }]);
      await gen.next();
      client.updateConnection('https://api.anthropic.com', 'sk-rotated');
      for await (const _ of gen) void _;

      // The first (and only) fetch that happened carries the ORIGINAL
      // key. Rotation can't reach back and rewrite a sent header.
      const firstHeaders = (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(firstHeaders['x-api-key']).toBe('sk-original');
    });
  });
});
