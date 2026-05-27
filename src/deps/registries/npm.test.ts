import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchNpmLatest } from './npm.js';

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, json: async () => body }));
}

describe('fetchNpmLatest', () => {
  it('returns the version from a successful response', async () => {
    mockFetch(200, { version: '18.2.0' });
    expect(await fetchNpmLatest('react')).toBe('18.2.0');
  });

  it('encodes the package name in the URL', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0' }) });
    vi.stubGlobal('fetch', spy);
    await fetchNpmLatest('@scope/pkg');
    expect(spy.mock.calls[0][0]).toContain(encodeURIComponent('@scope/pkg'));
  });

  it('returns undefined when response is not ok', async () => {
    mockFetch(404, {});
    expect(await fetchNpmLatest('nonexistent')).toBeUndefined();
  });

  it('returns undefined when version field is missing', async () => {
    mockFetch(200, {});
    expect(await fetchNpmLatest('react')).toBeUndefined();
  });

  it('returns undefined when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    expect(await fetchNpmLatest('react')).toBeUndefined();
  });

  it('passes the abort signal to fetch', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0' }) });
    vi.stubGlobal('fetch', spy);
    const signal = AbortSignal.abort();
    await fetchNpmLatest('react', signal);
    expect(spy.mock.calls[0][1]).toMatchObject({ signal });
  });
});
