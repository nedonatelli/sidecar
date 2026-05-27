import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPypiLatest } from './pypi.js';

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, json: async () => body }));
}

describe('fetchPypiLatest', () => {
  it('returns the version from info.version', async () => {
    mockFetch(200, { info: { version: '2.28.2' } });
    expect(await fetchPypiLatest('requests')).toBe('2.28.2');
  });

  it('encodes the package name in the URL', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ info: { version: '1.0.0' } }) });
    vi.stubGlobal('fetch', spy);
    await fetchPypiLatest('my package');
    expect(spy.mock.calls[0][0]).toContain(encodeURIComponent('my package'));
  });

  it('returns undefined when response is not ok', async () => {
    mockFetch(404, {});
    expect(await fetchPypiLatest('nonexistent')).toBeUndefined();
  });

  it('returns undefined when info is missing', async () => {
    mockFetch(200, {});
    expect(await fetchPypiLatest('requests')).toBeUndefined();
  });

  it('returns undefined when info.version is missing', async () => {
    mockFetch(200, { info: {} });
    expect(await fetchPypiLatest('requests')).toBeUndefined();
  });

  it('returns undefined when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    expect(await fetchPypiLatest('requests')).toBeUndefined();
  });

  it('passes the abort signal to fetch', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ info: { version: '1.0.0' } }) });
    vi.stubGlobal('fetch', spy);
    const signal = AbortSignal.abort();
    await fetchPypiLatest('requests', signal);
    expect(spy.mock.calls[0][1]).toMatchObject({ signal });
  });
});
