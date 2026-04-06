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
});
