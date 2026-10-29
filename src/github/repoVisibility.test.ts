import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRepoVisibility } from './repoVisibility.js';

function respond(status: number, body: unknown = {}) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

describe('fetchRepoVisibility', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports a public repo', async () => {
    const f = respond(200, { private: false });
    expect(await fetchRepoVisibility('https://github.com/owner/repo.git')).toBe('public');
    expect(String(f.mock.calls[0][0])).toBe('https://api.github.com/repos/owner/repo');
  });

  it('reports a private repo when the token can see it', async () => {
    const f = respond(200, { private: true });
    expect(await fetchRepoVisibility('git@github.com:owner/bench.git', 'tok')).toBe('private');
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('sends no Authorization header without a token', async () => {
    const f = respond(200, { private: false });
    await fetchRepoVisibility('https://github.com/owner/repo.git', null);
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("says 'not public' on a 404", async () => {
    respond(404, { message: 'Not Found' });
    expect(await fetchRepoVisibility('https://github.com/owner/secret.git')).toBe('not public');
  });

  it('says nothing for a non-GitHub remote, without a request', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    expect(await fetchRepoVisibility('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('says nothing when GitHub cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(await fetchRepoVisibility('https://github.com/owner/repo.git')).toBeNull();
  });

  it('says nothing on a rate-limit or server error', async () => {
    respond(403, { message: 'rate limited' });
    expect(await fetchRepoVisibility('https://github.com/owner/repo.git')).toBeNull();
  });
});
