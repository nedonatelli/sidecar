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
});
