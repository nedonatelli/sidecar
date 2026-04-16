import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Stub the kickstand token file so the test is deterministic regardless of
// whether the machine running it has ~/.config/kickstand/token set up.
// Without this mock, the `Authorization` header assertion fails as
// "undefined vs string" on any host that lacks the token file (e.g. CI).
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (p: string) => (p.includes('kickstand/token') ? true : actual.existsSync(p)),
    readFileSync: (p: string, enc?: BufferEncoding) =>
      p.includes('kickstand/token') ? 'test-kickstand-token' : actual.readFileSync(p, enc),
  };
});

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

  it('checks /v1/models for anthropic (not the bare root URL)', async () => {
    // Regression: probing https://api.anthropic.com/ returns 404 and
    // used to make reachability reports "Cannot reach API" even when
    // the API and key were both fine. Must hit /v1/models instead.
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    await isProviderReachable('anthropic');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.anything());
  });

  it('treats a 401 from anthropic as reachable (auth is a separate problem)', async () => {
    // Regression: a bad key must not masquerade as an outage. The
    // actual chat request will surface a specific 401 error that's
    // more useful than "cannot reach API".
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const result = await isProviderReachable('anthropic');
    expect(result).toBe(true);
  });

  it('treats a 500 from anthropic as unreachable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const result = await isProviderReachable('anthropic');
    expect(result).toBe(false);
  });

  it('returns false for anthropic on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const result = await isProviderReachable('anthropic');
    expect(result).toBe(false);
  });
});
