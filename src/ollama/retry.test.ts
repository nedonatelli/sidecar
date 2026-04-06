import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWithRetry } from './retry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('fetchWithRetry', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns response on first success', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('http://test', {}, { maxAttempts: 3, baseDelayMs: 1 });

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 and succeeds on second attempt', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('http://test', {}, { maxAttempts: 3, baseDelayMs: 1 });

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('http://test', {}, { maxAttempts: 3, baseDelayMs: 1 });

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 502, 503, 504', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 502, headers: new Headers() })
      .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('http://test', {}, { maxAttempts: 3, baseDelayMs: 1 });

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('returns error response after exhausting retries', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, headers: new Headers() });

    const response = await fetchWithRetry('http://test', {}, { maxAttempts: 2, baseDelayMs: 1 });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 400 (non-retryable status)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, headers: new Headers() });

    const response = await fetchWithRetry('http://test', {}, { maxAttempts: 3, baseDelayMs: 1 });

    expect(response.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401 (non-retryable status)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, headers: new Headers() });

    const response = await fetchWithRetry('http://test', {}, { maxAttempts: 3, baseDelayMs: 1 });

    expect(response.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on network errors and succeeds', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('http://test', {}, { maxAttempts: 3, baseDelayMs: 1 });

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on network errors', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchWithRetry('http://test', {}, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow('ECONNREFUSED');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry AbortError', async () => {
    const abortErr = new DOMException('Aborted', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortErr);

    await expect(fetchWithRetry('http://test', {}, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('Aborted');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('respects Retry-After header (seconds)', async () => {
    const start = Date.now();
    const headers = new Headers();
    headers.set('retry-after', '0'); // 0 seconds for fast test

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('http://test', {}, { maxAttempts: 3, baseDelayMs: 5000 });

    expect(response.ok).toBe(true);
    // Should have used Retry-After (0s) instead of baseDelay (5s)
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('retries with custom retryableStatuses', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 418, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry(
      'http://test',
      {},
      { maxAttempts: 3, baseDelayMs: 1, retryableStatuses: [418] },
    );

    expect(response.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
