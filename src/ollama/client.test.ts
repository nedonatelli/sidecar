import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SideCarClient } from './client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SideCarClient', () => {
  let client: SideCarClient;

  beforeEach(() => {
    client = new SideCarClient('test-model');
    mockFetch.mockReset();
  });

  describe('constructor defaults', () => {
    it('uses default base URL and API key', () => {
      // Verify by checking isLocalOllama which inspects baseUrl
      expect(client.isLocalOllama()).toBe(true);
    });

    it('accepts custom base URL', () => {
      const custom = new SideCarClient('model', 'https://api.anthropic.com');
      expect(custom.isLocalOllama()).toBe(false);
    });
  });

  describe('updateModel', () => {
    it('changes the model used in requests', async () => {
      client.updateModel('new-model');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });

      await client.complete([{ role: 'user', content: 'hi' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('new-model');
    });
  });

  describe('updateSystemPrompt', () => {
    it('includes system prompt in request body', async () => {
      client.updateSystemPrompt('You are helpful.');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });

      await client.complete([{ role: 'user', content: 'hi' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.system).toBe('You are helpful.');
    });
  });

  describe('complete', () => {
    it('returns text from a successful response', async () => {
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

    it('returns empty string when no text block found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'tool_use', id: 'tc1', name: 'read_file', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });

      const result = await client.complete([{ role: 'user', content: 'read a file' }]);
      expect(result).toBe('');
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'something broke',
      });

      await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
        'API request failed: 500 Internal Server Error',
      );
    });

    it('sends correct headers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });

      await client.complete([{ role: 'user', content: 'hi' }]);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['x-api-key']).toBe('ollama');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });
  });

  describe('updateConnection', () => {
    it('changes base URL and API key', () => {
      client.updateConnection('https://example.com', 'sk-test');
      expect(client.isLocalOllama()).toBe(false);
    });

    it('falls back to defaults when given empty strings', () => {
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
