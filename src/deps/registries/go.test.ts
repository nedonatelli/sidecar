import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchGoLatest } from './go.js';

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, json: async () => body }));
}

describe('fetchGoLatest', () => {
  it('returns the version with leading v stripped', async () => {
    mockFetch(200, { Version: 'v1.9.1' });
    expect(await fetchGoLatest('github.com/gin-gonic/gin')).toBe('1.9.1');
  });

  it('encodes uppercase letters with !lowercase in the URL', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Version: 'v1.0.0' }) });
    vi.stubGlobal('fetch', spy);
    await fetchGoLatest('github.com/MyOrg/MyRepo');
    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('!my!org/!my!repo');
  });

  it('returns undefined when response is not ok', async () => {
    mockFetch(404, {});
    expect(await fetchGoLatest('github.com/nonexistent/pkg')).toBeUndefined();
  });

  it('returns undefined when Version field is absent', async () => {
    mockFetch(200, {});
    expect(await fetchGoLatest('github.com/foo/bar')).toBeUndefined();
  });

  it('returns undefined when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    expect(await fetchGoLatest('github.com/foo/bar')).toBeUndefined();
  });

  it('passes the abort signal to fetch', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Version: 'v1.0.0' }) });
    vi.stubGlobal('fetch', spy);
    const signal = AbortSignal.abort();
    await fetchGoLatest('golang.org/x/net', signal);
    expect(spy.mock.calls[0][1]).toMatchObject({ signal });
  });
});
