import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchCargoLatest } from './cargo.js';

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, json: async () => body }));
}

describe('fetchCargoLatest', () => {
  it('returns max_stable_version when present', async () => {
    mockFetch(200, { crate: { max_stable_version: '1.0.176', newest_version: '1.0.177-alpha' } });
    expect(await fetchCargoLatest('serde')).toBe('1.0.176');
  });

  it('falls back to newest_version when max_stable_version is absent', async () => {
    mockFetch(200, { crate: { newest_version: '0.9.0' } });
    expect(await fetchCargoLatest('serde')).toBe('0.9.0');
  });

  it('encodes the crate name in the URL', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ crate: { max_stable_version: '1.0.0' } }),
    });
    vi.stubGlobal('fetch', spy);
    await fetchCargoLatest('my-crate');
    expect(spy.mock.calls[0][0]).toContain(encodeURIComponent('my-crate'));
  });

  it('sends a User-Agent header', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ crate: { max_stable_version: '1.0.0' } }),
    });
    vi.stubGlobal('fetch', spy);
    await fetchCargoLatest('serde');
    expect(spy.mock.calls[0][1].headers).toMatchObject({ 'User-Agent': expect.stringContaining('sidecar') });
  });

  it('returns undefined when response is not ok', async () => {
    mockFetch(404, {});
    expect(await fetchCargoLatest('nonexistent')).toBeUndefined();
  });

  it('returns undefined when crate field is absent', async () => {
    mockFetch(200, {});
    expect(await fetchCargoLatest('serde')).toBeUndefined();
  });

  it('returns undefined when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    expect(await fetchCargoLatest('serde')).toBeUndefined();
  });

  it('passes the abort signal to fetch', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ crate: { max_stable_version: '1.0.0' } }),
    });
    vi.stubGlobal('fetch', spy);
    const signal = AbortSignal.abort();
    await fetchCargoLatest('serde', signal);
    expect(spy.mock.calls[0][1]).toMatchObject({ signal });
  });
});
