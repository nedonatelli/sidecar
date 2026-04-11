import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { isProviderReachable } from './providerReachability.js';

describe('isProviderReachable', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns true when provider responds ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await isProviderReachable('ollama');
    expect(result).toBe(true);
  });

  it('returns false when provider responds not ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await isProviderReachable('ollama');
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await isProviderReachable('ollama');
    expect(result).toBe(false);
  });

  it('checks /api/tags for ollama', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await isProviderReachable('ollama');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/tags'), expect.anything());
  });

  it('checks /v1/models for openai', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await isProviderReachable('openai');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.anything());
  });

  it('sends x-api-key header for anthropic', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await isProviderReachable('anthropic');
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBeDefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends Authorization header for kickstand', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await isProviderReachable('kickstand');
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toContain('Bearer');
  });
});
